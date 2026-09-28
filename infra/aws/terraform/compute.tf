// Application host: one EC2 instance in a private subnet.
//
// It runs the same `infra/deployment/docker-compose.yml` the single-host runbook
// documents — dashboard, API and worker — so the AWS shape and the runbook shape
// are the same topology, not two products that drift. The SSD is gp3, encrypted,
// and holds the Docker images; the control plane stays in Supabase.

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_key_pair" "admin" {
  count      = var.ssh_public_key == "" ? 0 : 1
  key_name   = "${var.project}-${var.environment}-admin"
  public_key = var.ssh_public_key
}

resource "aws_iam_role" "app" {
  name = "${var.project}-${var.environment}-app"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

// Session Manager, so an operator can open a shell without an SSH key or an open
// port. This is the documented access path (see the runbook).
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

// Read-only access to the log group and the config bucket, nothing more. The
// instance does not need AWS APIs to run the product; the control plane and the
// engines are reached with the credentials in its environment file.
resource "aws_iam_role_policy" "app" {
  name = "${var.project}-${var.environment}-app"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.config.arn, "${aws_s3_bucket.config.arn}/*"]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.project}-${var.environment}-app"
  role = aws_iam_role.app.name
}

// The environment file the containers read. Held in SSM Parameter Store as a
// SecureString, so it is encrypted at rest and never printed by Terraform, and
// fetched by the host's bootstrap at first boot.
//
// It is written as one document because compose reads one file. The per-tenant
// Coolify and storage keys are added by the operator after provisioning — the
// template cannot express a key with `<organizationId>` in it (see
// docs/adr/0014), so they are appended with `aws ssm put-parameter` and a
// re-bootstrap.
resource "aws_ssm_parameter" "env" {
  name        = "/${var.project}/${var.environment}/env"
  description = "Cloud Wai container environment (control plane and engines)"
  type        = "SecureString"
  tier        = "Standard"
  value = join("\n", compact([
    "NODE_ENV=production",
    "HOST=0.0.0.0",
    "PORT=8787",
    "SUPABASE_URL=${var.supabase_url}",
    "SUPABASE_ANON_KEY=${var.supabase_anon_key}",
    "SUPABASE_SERVICE_ROLE_KEY=${var.supabase_service_role_key}",
    "CLOUD_WAI_SECRET_ENCRYPTION_KEY=${var.cloud_wai_secret_encryption_key}",
    "CLOUD_WAI_ALLOWED_ORIGINS=${var.allowed_origins}",
    "CLOUD_WAI_USE_FAKE_ENGINES=false",
    "PUBLIC_SUPABASE_URL=${var.public_supabase_url}",
    "VITE_SUPABASE_URL=${var.public_supabase_url}",
    "VITE_SUPABASE_ANON_KEY=${var.supabase_anon_key}",
    "COOLIFY_URL=${var.coolify_url}",
    "SECURITY_EDGE_URL=${var.security_edge_url}",
    "SECURITY_EDGE_ORIGIN=${var.security_edge_origin}",
    "SECURITY_EDGE_BOT_ALLOWLIST=${var.security_edge_bot_allowlist}",
    "EDGE_HOSTNAME=${var.edge_hostname}",
    "STORAGE_ENDPOINT=${var.storage_endpoint}",
    // The build plane (ADR-0018). BUILDER_TOKEN is the builder service's own
    // secret; the per-organization BUILD_ENGINE_URL__/TOKEN__ keys cannot be
    // expressed here (they carry an organization id, which the dotenv/Compose
    // parser refuses — the same limitation as COOLIFY_TOKEN__) and are appended
    // to this parameter by the operator after provisioning (see deploy-aws.md).
    "BUILDER_TOKEN=${var.builder_token}",
    "BUILDER_PORT=8090",
    "BUILDER_HOST=0.0.0.0",
    "BUILDER_CONCURRENCY=${var.builder_concurrency}",
    // The self-hosted runtime (ADR-0020). RUNTIME_PUBLIC_HOST is the address a
    // deployed app's url is built from; without it the runtime advertises
    // 127.0.0.1, which only the host can reach. RUNTIME_URL and the
    // per-organization RUNTIME_TOKEN__ keys are appended by the bootstrap (the
    // runtime's own port is not known until it starts).
    var.runtime_public_host == "" ? null : "RUNTIME_PUBLIC_HOST=${var.runtime_public_host}",
  ]))
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

// The application tier is a launch template + Auto Scaling group, not one
// instance. Every instance runs the same compose stack (dashboard, API, worker),
// and the worker claims jobs with `for update skip locked`, so scaling out adds
// throughput without double-processing. The template carries the bootstrap as
// user data, so a scaled-out instance is configured exactly like the first.
resource "aws_launch_template" "app" {
  name_prefix   = "${var.project}-${var.environment}-app-"
  image_id      = var.instance_ami_id != "" ? var.instance_ami_id : data.aws_ami.al2023.id
  instance_type = var.instance_type
  key_name      = var.ssh_public_key == "" ? null : aws_key_pair.admin[0].key_name

  iam_instance_profile {
    name = aws_iam_instance_profile.app.name
  }

  vpc_security_group_ids = [aws_security_group.app.id]

  // IMDSv2 only: the host has an IAM role, so the metadata service must not be
  // reachable by a simple request from anything that gets a foothold in a
  // container.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_type           = "gp3"
      volume_size           = 30
      encrypted             = true
      delete_on_termination = true
    }
  }

  // A launch template reads `user_data` base64-encoded; the provider does not
  // encode it here, so the bootstrap is encoded explicitly.
  user_data = base64encode(templatefile("${path.module}/templates/bootstrap.sh.tftpl", {
    repo_url      = var.repo_url
    repo_ref      = var.repo_ref
    env_parameter = aws_ssm_parameter.env.name
    log_group     = aws_cloudwatch_log_group.app.name
    project       = var.project
    environment   = var.environment
    config_bucket = aws_s3_bucket.config.bucket
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.project}-${var.environment}-app" }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "app" {
  name = "${var.project}-${var.environment}-app"

  // Both private subnets, so min ≥ 2 is genuinely one instance per AZ.
  vpc_zone_identifier = aws_subnet.private[*].id

  min_size         = var.app_min_size
  desired_capacity = var.app_desired_capacity
  max_size         = var.app_max_size

  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }

  // Register with the load balancer, and let the LB's health check — the same
  // `/healthz` the runbook curls — decide health, not just the EC2 status check.
  target_group_arns         = [aws_lb_target_group.web.arn]
  health_check_type         = "ELB"
  health_check_grace_period = var.app_health_check_grace_period

  // First boot installs Docker and builds images; do not let a scaling policy and
  // the group's own capacity fight each other.
  lifecycle {
    ignore_changes = [desired_capacity]
  }

  tag {
    key                 = "Name"
    value               = "${var.project}-${var.environment}-app"
    propagate_at_launch = true
  }
}

// Target tracking holds average instance CPU near `app_cpu_target`: out when a
// build or a request burst pushes it up, back in when it falls. The group exists
// without it; this is what makes it resize on its own.
resource "aws_autoscaling_policy" "cpu" {
  count = var.autoscaling_enabled ? 1 : 0

  name                   = "${var.project}-${var.environment}-cpu-target"
  autoscaling_group_name = aws_autoscaling_group.app.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = var.app_cpu_target
  }
}
