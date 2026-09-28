/**
 * Whether the stored protection is currently in effect.
 *
 * A single place for the expiry rule, so the API, the worker and the edge loaders
 * cannot disagree about whether attack mode is on. In its own module so the edge
 * loaders can import it without a cycle through the package index.
 */
import type { DeploymentProtection, SecurityPolicy } from "./index.js";

export function protectionIsActive(
  policy: Pick<SecurityPolicy, "protectionMode" | "protectionExpiresAt">,
  now: Date = new Date(),
): boolean {
  if (policy.protectionMode !== "attack") return false;
  if (policy.protectionExpiresAt === null) return true;
  return new Date(policy.protectionExpiresAt).getTime() > now.getTime();
}

/**
 * Whether a deployment-protection posture is currently in effect.
 *
 * The same expiry rule as attack mode, applied to the other protection: a
 * `none` posture is never in effect, and a posture with a past expiry has lapsed
 * back to open. One place for the rule, so the API, the worker and the edge
 * loaders cannot disagree about whether a preview is still protected.
 */
export function deploymentProtectionIsActive(
  protection: Pick<DeploymentProtection, "mode" | "protectionExpiresAt">,
  now: Date = new Date(),
): boolean {
  if (protection.mode === "none") return false;
  if (protection.protectionExpiresAt === null) return true;
  return new Date(protection.protectionExpiresAt).getTime() > now.getTime();
}

/**
 * The compiled posture a route should carry, or `none` when it has lapsed.
 *
 * The password *digest* is supplied separately because it is not part of the
 * client-facing `DeploymentProtection` shape (it is not in the client SELECT
 * grant). The caller that compiles for the edge reads it on the service role and
 * passes it here, so the artifact Envoy reads carries the digest and the control
 * plane still never returns it to a browser.
 */
export function compiledProtectionFor(
  protection: DeploymentProtection | null,
  passwordHash: string | null = null,
  now: Date = new Date(),
):
  | { mode: "none" }
  | { mode: "ip"; allowedCidrs: readonly string[] }
  | { mode: "password"; basicUser: string; basicPasswordSha256: string } {
  if (!protection || !deploymentProtectionIsActive(protection, now)) return { mode: "none" };
  if (protection.mode === "ip") return { mode: "ip", allowedCidrs: protection.allowedCidrs };
  // A password posture without a digest cannot be enforced, so it is open rather
  // than a route that pretends to be protected but lets everything through.
  if (!passwordHash) return { mode: "none" };
  return {
    mode: "password",
    basicUser: protection.basicUser ?? "",
    basicPasswordSha256: passwordHash,
  };
}
