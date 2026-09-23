#!/usr/bin/env python3
"""Generate LICENSES/engines.json and LICENSES/third-party-inventory.md.

Input: the verified engine inventory recollected from the on-disk clones under
engines-src/. Two corrections are encoded explicitly because a naive
first-match scanner cannot make them:

  - haproxy: the LICENSE text mentions "GPL version 2" but has no stock SPDX
    header, so it is recorded as GPL-2.0-only with its documented LGPL
    include-file exception and OpenSSL linking exemption.
  - postgres: the license lives in COPYRIGHT (not LICENSE) and is the
    PostgreSQL License, which is not in the SPDX pattern list.
"""
import json
import os
import subprocess

ROOT = "/workspace/USCS"
SRC = os.path.join(ROOT, "engines-src")

SPDX_OVERRIDES = {
    "haproxy": {
        "spdx": "GPL-2.0-only",
        "license_file": "LICENSE",
        "note": (
            "GPL-2.0 core, with LGPL applied to exportable include files, plus the "
            "documented exemption permitting linking against OpenSSL. A modified "
            "HAProxy build carries source obligations, so HAProxy is an optional "
            "edge provider behind SecurityEdgeAdapter, not a default dependency."
        ),
    },
    "postgres": {
        "spdx": "PostgreSQL",
        "license_file": "COPYRIGHT",
        "note": (
            "The PostgreSQL License (permissive, BSD-like); the text lives in "
            "COPYRIGHT rather than LICENSE. Operated as an independent database "
            "engine, so only attribution is required."
        ),
    },
}

ENGINES = [
    ("coolify", "https://github.com/coollabsio/coolify", "deployment/hosting engine"),
    ("supabase", "https://github.com/supabase/supabase", "control-plane auth + Postgres + RLS"),
    ("minio", "https://github.com/minio/minio", "S3-compatible object storage"),
    ("envoy", "https://github.com/envoyproxy/envoy", "edge data plane (primary)"),
    ("haproxy", "https://github.com/haproxy/haproxy", "edge data plane (optional)"),
    ("coraza", "https://github.com/corazawaf/coraza", "WAF engine (Go library)"),
    ("coreruleset", "https://github.com/coreruleset/coreruleset", "WAF rule set"),
    ("crowdsec", "https://github.com/crowdsecurity/crowdsec", "behavioural detection"),
    ("valkey", "https://github.com/valkey-io/valkey", "rate/risk cache and queue"),
    ("postgres", "https://github.com/postgres/postgres", "relational engine"),
    ("opa", "https://github.com/open-policy-agent/opa", "policy evaluation"),
    ("trivy", "https://github.com/aquasecurity/trivy", "vulnerability scanning"),
    ("syft", "https://github.com/anchore/syft", "SBOM generation"),
    ("cosign", "https://github.com/sigstore/cosign", "image signing"),
    ("otelcol", "https://github.com/open-telemetry/opentelemetry-collector", "telemetry pipeline"),
    ("prometheus", "https://github.com/prometheus/prometheus", "metrics"),
    ("grafana", "https://github.com/grafana/grafana", "operator dashboards"),
    ("containerd", "https://github.com/containerd/containerd", "container runtime"),
    ("runc", "https://github.com/opencontainers/runc", "OCI runtime"),
    ("cni", "https://github.com/containernetworking/cni", "container networking"),
]

# SPDX values verified on disk by scripts/license-inventory.py's sibling scan.
SPDX_VERIFIED = {
    "coolify": "Apache-2.0", "supabase": "Apache-2.0", "minio": "AGPL-3.0",
    "envoy": "Apache-2.0", "coraza": "Apache-2.0", "coreruleset": "Apache-2.0",
    "crowdsec": "MIT", "valkey": "BSD-3-Clause", "opa": "Apache-2.0",
    "trivy": "Apache-2.0", "syft": "Apache-2.0", "cosign": "Apache-2.0",
    "otelcol": "Apache-2.0", "prometheus": "Apache-2.0", "grafana": "AGPL-3.0",
    "containerd": "Apache-2.0", "runc": "Apache-2.0", "cni": "Apache-2.0",
}

DECISIONS = {
    "coolify": ("WRAP", "Version-pinned HostingAdapter; never the identity source."),
    "supabase": ("ADOPT", "Control-plane identity and operational database."),
    "minio": ("ADOPT", "Isolated service behind StorageAdapter. AGPL service use only."),
    "envoy": ("ADOPT", "Primary edge data plane; ext_authz and rate-limit gRPC API."),
    "haproxy": ("OPTIONAL", "GPL obligations keep it a non-default alternative behind the same adapter."),
    "coraza": ("WRAP", "Go WAF library embedded in the edge, driven by compiled Cloud Wai policy."),
    "coreruleset": ("ADOPT", "Pinned rule set with documented false-positive exclusions."),
    "crowdsec": ("ADOPT", "Independent daemon; an extra signal, never a WAF substitute."),
    "valkey": ("ADOPT", "Rebuildable cache/queue only; never billing, identity or audit truth."),
    "postgres": ("ADOPT", "Engine for both planes, operated as separate instances."),
    "opa": ("ADOPT", "Compiled policy decisions where appropriate."),
    "trivy": ("ADOPT", "Build/security pipeline scanning."),
    "syft": ("ADOPT", "SBOM per release image."),
    "cosign": ("ADOPT", "Signature verification for trusted deploy paths."),
    "otelcol": ("ADOPT", "Async telemetry with secret redaction."),
    "prometheus": ("ADOPT", "Metrics and alerting."),
    "grafana": ("ADOPT", "Internal operator dashboards; AGPL service use, no redistribution."),
    "containerd": ("REJECT", "Not needed while Coolify owns container lifecycle."),
    "runc": ("REJECT", "Transitively present via the container runtime; not a direct dependency."),
    "cni": ("REJECT", "Network policy comes from the runtime/Coolify; revisit if we self-run Kubernetes."),
}


def git(repo, *args):
    result = subprocess.run(["git", "-C", os.path.join(SRC, repo), *args],
                            capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


rows = []
for repo, url, role in ENGINES:
    override = SPDX_OVERRIDES.get(repo)
    decision, reason = DECISIONS[repo]
    rows.append({
        "engine": repo,
        "upstream": url,
        "commit": git(repo, "rev-parse", "HEAD"),
        "commit_date": git(repo, "log", "-1", "--format=%ad", "--date=short"),
        "license_file": override["license_file"] if override else "LICENSE",
        "spdx": override["spdx"] if override else SPDX_VERIFIED[repo],
        "role": role,
        "decision": decision,
        "decision_reason": reason,
        "note": override["note"] if override else "",
    })

os.makedirs(os.path.join(ROOT, "LICENSES"), exist_ok=True)
with open(os.path.join(ROOT, "LICENSES", "engines.json"), "w", encoding="utf-8") as fh:
    json.dump({"engines": rows}, fh, indent=2)
    fh.write("\n")

lines = [
    "# Third-party engine inventory",
    "",
    "Generated by `scripts/license-inventory.py` from the pinned clones under",
    "`engines-src/`. Each commit below is the exact revision inspected. No engine",
    "source is vendored into this repository.",
    "",
    "| Engine | Pinned commit | License (SPDX) | License file | Decision | Role |",
    "|---|---|---|---|---|---|",
]
for row in rows:
    lines.append(
        f"| {row['engine']} | `{row['commit'][:12]}` ({row['commit_date']}) | "
        f"{row['spdx']} | `{row['license_file']}` | {row['decision']} | {row['role']} |"
    )

lines += ["", "## Decision rationale", ""]
for row in rows:
    lines.append(f"- **{row['engine']}** — {row['decision']}: {row['decision_reason']}")

lines += [
    "",
    "## License obligations that constrain the design",
    "",
    "- **MinIO (AGPL-3.0) and Grafana (AGPL-3.0)** run as independent network",
    "  services. No MinIO or Grafana code is linked into, or copied into, the",
    "  Cloud Wai tree; their source-offer obligations attach to the service",
    "  deployment, not to Cloud Wai's own code.",
    "- **HAProxy (GPL-2.0)** carries source-distribution obligations for modified",
    "  builds, so it is an optional edge provider rather than a default. Envoy",
    "  (Apache-2.0) is the default edge implementation.",
    "- **Coolify (Apache-2.0)** is version-pinned and its LICENSE/NOTICE are",
    "  preserved with the deployed service; Cloud Wai stores provider references",
    "  only, never Coolify code.",
    "- **Supabase (Apache-2.0)** is the control-plane foundation. The GoTrue auth",
    "  server and several services are consumed as published images, so their",
    "  sources are not part of this repository. Cloud Wai's own workspaces declare",
    "  `UNLICENSED` (private, all rights reserved) in their manifests.",
    "- **PostgreSQL** uses the PostgreSQL License, recorded above from `COPYRIGHT`.",
    "",
    "## Upgrade and patch ownership",
    "",
    "Every engine is pinned and upgraded deliberately: bump the pin in",
    "`LICENSES/engines.json`, re-run the inspection protocol, re-run the contract",
    "and isolation tests, and record an ADR when a decision changes.",
    "",
]

with open(os.path.join(ROOT, "LICENSES", "third-party-inventory.md"), "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines))

print(f"wrote LICENSES/engines.json and LICENSES/third-party-inventory.md ({len(rows)} engines)")
