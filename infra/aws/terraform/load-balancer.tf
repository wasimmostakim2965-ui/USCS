// Application load balancer.
//
// One HTTPS listener on :443 with the ACM certificate, and an HTTP listener on
// :80 that only redirects. The target group points at the dashboard container's
// port, and its health check is the same `/healthz` the runbook tells an
// operator to curl — so "the load balancer thinks it is healthy" and "the
// documented liveness check passes" are the same statement, not two.

resource "aws_lb" "main" {
  name               = "${var.project}-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.web.id]
  subnets            = aws_subnet.public[*].id

  // The dashboard is a control plane; access logs go to the bucket in
  // observability.tf, where they are retained and encryptable.
  access_logs {
    bucket  = aws_s3_bucket.logs.bucket
    prefix  = "alb"
    enabled = true
  }

  drop_invalid_header_fields = true

  tags = { Name = "${var.project}-${var.environment}-alb" }
}

resource "aws_lb_target_group" "web" {
  name     = "${var.project}-${var.environment}-web"
  port     = 8080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  // The dashboard is stateless; a short drain keeps a deploy from cutting a
  // request in flight, without waiting a minute for a dead host to leave.
  deregistration_delay = 30

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.project}-${var.environment}-web" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_target_group_attachment" "web" {
  target_group_arn = aws_lb_target_group.web.arn
  target_id        = aws_instance.app.id
  port             = 8080
}
