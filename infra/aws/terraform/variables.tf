// Deployment inputs.
//
// Nothing here has a working default that changes behaviour: a value the
// operator must choose (region, domain, control plane) is required, so
// `terraform plan` fails rather than quietly building the wrong thing. The
// optional values only widen a shape that already works.

variable "project" {
  description = "Name every resource carries. Also the prefix for generated names."
  type        = string
  default     = "cloud-wai"
}

variable "environment" {
  description = "Deployment name, e.g. prod or staging. Two environments can share an account."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Public hostname the dashboard is served on, e.g. app.example.com. TLS is issued for it."
  type        = string
}

variable "route53_zone_id" {
  description = "Existing Route 53 hosted zone that holds domain_name. Empty skips DNS record creation."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type for the application host."
  type        = string
  default     = "t3.small"
}

variable "ssh_public_key" {
  description = "Public key installed for the deploy/ops user. Empty creates no key pair, so there is no SSH entry point."
  type        = string
  default     = ""
}

variable "admin_cidr_blocks" {
  description = "CIDRs allowed to reach SSH. Empty closes SSH entirely; the SSM agent is the intended access path."
  type        = list(string)
  default     = []
}

variable "instance_ami_id" {
  description = "Override the AMI. Empty resolves the latest Amazon Linux 2023 image for the region."
  type        = string
  default     = ""
}

// --- Control plane -----------------------------------------------------------
// The control plane is Supabase (ADR-0004). These are passed to the host's
// environment file. They are marked sensitive so Terraform does not print them;
// they still live in the operator's state file, which is why the backend note in
// the runbook matters.

variable "supabase_url" {
  description = "Supabase project URL (the control plane)."
  type        = string
}

variable "supabase_anon_key" {
  description = "Supabase anon/publishable key. Compiled into the dashboard bundle; public by design."
  type        = string
}

variable "supabase_service_role_key" {
  description = "Supabase service-role key. Service side only; never reaches a browser."
  type        = string
  sensitive   = true
}

variable "allowed_origins" {
  description = "Browser origins allowed to call the API. Leave empty: the dashboard and API share one origin through the reverse proxy."
  type        = string
  default     = ""
}

// --- Engines (optional) ------------------------------------------------------
// An unset engine makes its adapter report `not_configured`, which the dashboard
// shows honestly. Setting one is how a release gate is closed, not a way to make
// the dashboard look full.

variable "coolify_url" {
  description = "Coolify base URL for the hosting engine. Empty leaves hosting not_configured."
  type        = string
  default     = ""
}

variable "security_edge_url" {
  description = "Envoy/Coraza edge URL. Empty leaves the edge not_configured; gates 6-8 stay open."
  type        = string
  default     = ""
}

variable "security_edge_origin" {
  description = <<-EOT
    The private origin the edge forwards to (e.g. http://10.0.1.20:8080). Required
    for the edge to build: securityEdgeConfigFromEnv refuses a missing or
    non-private origin, so a URL alone leaves the edge not_configured. Must be a
    private address, because the edge exists so the origin is not reachable
    directly.
  EOT
  type        = string
  default     = ""
}

variable "security_edge_bot_allowlist" {
  description = <<-EOT
    Extra verified bots to pre-allow on top of the curated crawler directory,
    so attack mode does not lock out this deployment's own webhook providers or
    uptime monitors. `name:userAgent:confirmSuffix` entries separated by `;`.
    The suffix must be a DNS name the edge forward-confirms; a malformed entry
    is dropped (fail-closed), never emitted as a bypass.
  EOT
  type        = string
  default     = ""
}

variable "edge_hostname" {
  description = "Hostname a domain may CNAME to for edge verification."
  type        = string
  default     = ""
}

variable "storage_endpoint" {
  description = "S3-compatible storage endpoint (MinIO) for tenant buckets. Empty leaves storage not_configured."
  type        = string
  default     = ""
}

// --- Source ------------------------------------------------------------------
// Where the host gets the code it runs. The bootstrap clones this and builds the
// images on the instance, which keeps the deployment to one artifact the operator
// already controls. Pointing at a fork or a tag is a variable, not an edit.

variable "repo_url" {
  description = "Git URL the host clones and builds."
  type        = string
  default     = "https://github.com/wasimmostakim2965-ui/USCS.git"
}

variable "repo_ref" {
  description = "Branch, tag or commit the host builds. Pin a tag for a release."
  type        = string
  default     = "main"
}
