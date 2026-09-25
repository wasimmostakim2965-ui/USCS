// Security groups: three, each with one job.
//
//   web-sg  reads :443 from the internet (and :80 only to redirect) to the ALB.
//   app-sg  reads :8080 from web-sg only — the dashboard container's port. The
//           API and worker have no inbound rule at all; they are reachable only
//           over the compose network inside the host.
//   end-sg  (in network.tf) reads :443 from app-sg for the SSM endpoints.
//
// SSH is not opened by default. Session Manager is the access path, so there is
// no public SSH door to forget to close; `admin_cidr_blocks` opens one only when
// an operator explicitly asks.

resource "aws_security_group" "web" {
  name        = "${var.project}-${var.environment}-web"
  description = "Public entry: TLS to the load balancer"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP, redirected to HTTPS at the listener"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  // Egress to the application host is a separate rule below. Inlining it here
  // would make this group and the application group reference each other, which
  // Terraform rejects as a dependency cycle before it ever plans.
  tags = { Name = "${var.project}-${var.environment}-web" }
}

resource "aws_security_group_rule" "web_to_app" {
  type                     = "egress"
  description              = "To the application host only"
  security_group_id        = aws_security_group.web.id
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
}

resource "aws_security_group" "app" {
  name        = "${var.project}-${var.environment}-app"
  description = "Application host: dashboard from the load balancer, egress to the engines"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Dashboard from the load balancer"
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id]
  }

  egress {
    description = "Control plane, engines and package mirrors"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-${var.environment}-app" }
}

// Optional SSH, only when an operator supplies both a key and a source CIDR.
resource "aws_security_group_rule" "app_ssh" {
  count = var.ssh_public_key != "" && length(var.admin_cidr_blocks) > 0 ? 1 : 0

  type              = "ingress"
  description       = "SSH from the operator CIDRs"
  security_group_id = aws_security_group.app.id
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = var.admin_cidr_blocks
}
