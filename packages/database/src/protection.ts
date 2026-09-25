/**
 * Whether the stored protection is currently in effect.
 *
 * A single place for the expiry rule, so the API, the worker and the edge loaders
 * cannot disagree about whether attack mode is on. In its own module so the edge
 * loaders can import it without a cycle through the package index.
 */
import type { SecurityPolicy } from "./index.js";

export function protectionIsActive(
  policy: Pick<SecurityPolicy, "protectionMode" | "protectionExpiresAt">,
  now: Date = new Date(),
): boolean {
  if (policy.protectionMode !== "attack") return false;
  if (policy.protectionExpiresAt === null) return true;
  return new Date(policy.protectionExpiresAt).getTime() > now.getTime();
}
