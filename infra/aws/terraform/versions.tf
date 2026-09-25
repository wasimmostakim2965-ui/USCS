// Provider and version constraints.
//
// The AWS provider is pinned to a major version so a `terraform init` months
// from now resolves to the same interface this configuration was validated
// against. Upgrading is a deliberate commit, not a side effect of a fresh init.
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region

  // Every resource carries the deployment name, so a shared account can tell
  // two deployments apart in the console and in billing.
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
