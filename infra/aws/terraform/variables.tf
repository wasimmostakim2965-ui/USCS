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

// --- Horizontal scaling ------------------------------------------------------
// The application tier is an Auto Scaling group behind the load balancer, not a
// single host. The worker claims a job with `for update skip locked`, so N
// instances can drain the same queue without double-processing; the dashboard and
// API are stateless. min ≥ 2 spreads the tier across both private AZs, so one
// instance failure is a capacity dip rather than downtime.

variable "app_min_size" {
  description = "Smallest number of application instances. 2 keeps one per availability zone, so a single instance failure is not downtime."
  type        = number
  default     = 2
  validation {
    condition     = var.app_min_size >= 1
    error_message = "app_min_size must be at least 1."
  }
}

variable "app_desired_capacity" {
  description = "Application instances to run at steady state. Must be between app_min_size and app_max_size."
  type        = number
  default     = 2
}

variable "app_max_size" {
  description = "Largest number of application instances the group may scale out to. Must be at least app_desired_capacity."
  type        = number
  default     = 6
  validation {
    condition     = var.app_max_size >= 1
    error_message = "app_max_size must be at least 1."
  }
}

variable "autoscaling_enabled" {
  description = "Attach a target-tracking policy so the group scales out under load and back in when it falls. The group still exists when false; it just does not resize on its own."
  type        = bool
  default     = true
}

variable "app_cpu_target" {
  description = "Average CPU percentage the target-tracking policy holds, as a percentage of instance CPU."
  type        = number
  default     = 60
}

variable "app_health_check_grace_period" {
  description = "Seconds an instance may be unhealthy before the group replaces it. Generous because first boot installs Docker, clones and builds images."
  type        = number
  default     = 600
}

variable "nat_gateway_per_az" {
  description = "One NAT gateway per availability zone instead of one shared. Removes the egress single point of failure at roughly double the NAT cost."
  type        = bool
  default     = false
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

variable "public_supabase_url" {
  description = "Browser-facing Supabase origin. Use the public gateway URL when Supabase is self-hosted behind a separate origin."
  type        = string
}

variable "cloud_wai_secret_encryption_key" {
  description = "Base64-encoded 32-byte key used to encrypt project environment variables and Git webhook secrets."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.cloud_wai_secret_encryption_key) >= 43
    error_message = "cloud_wai_secret_encryption_key must be a base64-encoded 32-byte key (at least 43 characters)."
  }
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

// --- Build plane (optional) --------------------------------------------------
// The Nixpacks build service (ADR-0018). It is the one engine that runs
// untrusted customer source and needs the Docker socket, so on this host it runs
// as its own container (`infra/deployment/builder.Dockerfile`) with the socket
// mounted and no public port. Empty token leaves builds not_configured.

variable "builder_token" {
  description = "Shared secret the builder service requires. Empty disables the build plane (builds stay not_configured)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "builder_concurrency" {
  description = "How many builds the builder runs at once. Each drives a Docker build; keep it small on one host."
  type        = number
  default     = 2
}

variable "runtime_public_host" {
  description = "Hostname or public IP a deployed app's URL is built from; empty uses the host's own address. The value is advertised to the control plane as the app's url, so it must be reachable by the tenant."
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
