// TLS: a DNS-validated certificate in ACM.
//
// The load balancer terminates TLS, so the containers keep speaking plain HTTP
// and the operator's reverse-proxy step in the single-host runbook is not
// needed. Validation is DNS, which means it can complete without anyone
// touching a web server, and it renews itself.

resource "aws_acm_certificate" "main" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  // The certificate must exist before the HTTPS listener references it.
  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.project}-${var.environment}-cert" }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.route53_zone_id == "" ? {} : {
    for option in aws_acm_certificate.main.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

// Blocks until ACM has observed the validation record, so the listener is only
// created for a certificate that is actually usable. When no hosted zone is
// supplied this resolves immediately and the operator validates by hand — the
// runbook says so rather than leaving a listener that fails silently.
resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

resource "aws_route53_record" "app" {
  count = var.route53_zone_id == "" ? 0 : 1

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
