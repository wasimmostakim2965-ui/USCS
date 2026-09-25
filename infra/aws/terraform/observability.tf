// Observability: where the product's own output lands.
//
// Two sinks, both real and both retained by policy rather than by hope:
//
//   logs bucket  — ALB access logs, encrypted, versioned, private, expiring.
//   log group    — the host ships docker's container output here, so `docker
//                  logs` is not the only copy and a lost instance does not lose
//                  the record.
//
// Neither is a metrics product. There is no dashboard metric here that no engine
// reported; the container logs are the containers' own lines.

resource "random_id" "logs_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "logs" {
  bucket = "${var.project}-${var.environment}-logs-${random_id.logs_suffix.hex}"
  tags   = { Name = "${var.project}-${var.environment}-logs" }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

// The ALB service writes access logs through this policy; without it the load
// balancer is created but its logs are silently dropped.
data "aws_elb_service_account" "main" {}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowALBAccessLogs"
        Effect    = "Allow"
        Principal = { AWS = data.aws_elb_service_account.main.arn }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.logs.arn}/alb/AWSLogs/*"
      },
      {
        // The ELB accounts also need to be able to check the bucket ACL.
        Sid       = "AllowALBGetBucketAcl"
        Effect    = "Allow"
        Principal = { AWS = data.aws_elb_service_account.main.arn }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.logs.arn
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.project}/${var.environment}/containers"
  retention_in_days = 30

  tags = { Name = "${var.project}-${var.environment}-containers" }
}

// A bucket for the operator's own artifacts (the environment file is in SSM, but
// a release tarball or an incident note has a place to go). Private and
// encrypted like the rest.
resource "aws_s3_bucket" "config" {
  bucket = "${var.project}-${var.environment}-config-${random_id.bucket_suffix.hex}"
  tags   = { Name = "${var.project}-${var.environment}-config" }
}

resource "aws_s3_bucket_public_access_block" "config" {
  bucket                  = aws_s3_bucket.config.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "config" {
  bucket = aws_s3_bucket.config.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "config" {
  bucket = aws_s3_bucket.config.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.config.arn, "${aws_s3_bucket.config.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

// --- Alarms ------------------------------------------------------------------
// Two alarms that correspond to a deployment being broken rather than busy:
// every target unhealthy, and the host's status check failing. They are the
// smallest set that tells an operator "this is down" without pretending to be a
// capacity or latency SLO, which needs real traffic to be meaningful.

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  alarm_name          = "${var.project}-${var.environment}-unhealthy-targets"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "No healthy dashboard target behind the load balancer."

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.web.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  alarm_name          = "${var.project}-${var.environment}-instance-status"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "The application host failed an instance or system status check."

  dimensions = { InstanceId = aws_instance.app.id }
}
