// Outputs an operator needs after applying: where the dashboard is, and the
// identifiers required to reach and re-bootstrap the host. No secret is output.

output "dashboard_url" {
  description = "Public HTTPS URL of the dashboard, once DNS points at the load balancer."
  value       = "https://${var.domain_name}"
}

output "load_balancer_dns" {
  description = "Load balancer DNS name. Point domain_name at this if no Route 53 zone was supplied."
  value       = aws_lb.main.dns_name
}

output "autoscaling_group_name" {
  description = "Auto Scaling group holding the application tier. Scale it by hand with: aws autoscaling set-desired-capacity --auto-scaling-group-name <name> --desired-capacity <n>"
  value       = aws_autoscaling_group.app.name
}

output "instance_profile_name" {
  description = "Instance profile attached to every application host."
  value       = aws_iam_instance_profile.app.name
}

output "env_parameter_name" {
  description = "SSM parameter holding the container environment. Append per-org engine keys here, then re-bootstrap."
  value       = aws_ssm_parameter.env.name
}

output "logs_bucket" {
  description = "S3 bucket holding load balancer access logs."
  value       = aws_s3_bucket.logs.bucket
}

output "config_bucket" {
  description = "Private S3 bucket for operator artifacts."
  value       = aws_s3_bucket.config.bucket
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group the host ships container logs to."
  value       = aws_cloudwatch_log_group.app.name
}

output "private_subnet_ids" {
  description = "Private subnets the application host lives in."
  value       = aws_subnet.private[*].id
}

output "rebootstrap_command" {
  description = "Force a re-run of the host bootstrap after changing the environment parameter, across every instance in the group."
  value = join(" ", [
    "aws autoscaling start-instance-refresh --auto-scaling-group-name",
    aws_autoscaling_group.app.name,
    "# or: aws ec2 reboot-instances --instance-ids <id> for a single instance",
  ])
}
