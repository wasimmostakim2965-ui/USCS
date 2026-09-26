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
    "CLOUD_WAI_ALLOWED_ORIGINS=${var.allowed_origins}",
    "CLOUD_WAI_USE_FAKE_ENGINES=false",
    "VITE_SUPABASE_URL=${var.supabase_url}",
    "VITE_SUPABASE_ANON_KEY=${var.supabase_anon_key}",
    "COOLIFY_URL=${var.coolify_url}",
    "SECURITY_EDGE_URL=${var.security_edge_url}",
    "SECURITY_EDGE_ORIGIN=${var.security_edge_origin}",
    "SECURITY_EDGE_BOT_ALLOWLIST=${var.security_edge_bot_allowlist}",
    "EDGE_HOSTNAME=${var.edge_hostname}",
    "STORAGE_ENDPOINT=${var.storage_endpoint}",
  ]))
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_instance" "app" {
  ami                    = var.instance_ami_id != "" ? var.instance_ami_id : data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name
  key_name               = var.ssh_public_key == "" ? null : aws_key_pair.admin[0].key_name

  // IMDSv2 only: the host has an IAM role, so the metadata service must not be
  // reachable by a simple request from anything that gets a foothold in a
  // container.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    encrypted             = true
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/templates/bootstrap.sh.tftpl", {
    repo_url      = var.repo_url
    repo_ref      = var.repo_ref
    env_parameter = aws_ssm_parameter.env.name
    log_group     = aws_cloudwatch_log_group.app.name
    project       = var.project
    environment   = var.environment
    config_bucket = aws_s3_bucket.config.bucket
  })

  // Re-run the bootstrap when its inputs change. Without this, an environment
  // change would sit in SSM with the old containers still running.
  user_data_replace_on_change = true

  depends_on = [aws_s3_bucket_policy.config]

  tags = { Name = "${var.project}-${var.environment}-app" }
}
