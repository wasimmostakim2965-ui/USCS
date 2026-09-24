/**
 * Domain verification adapter.
 *
 * A hostname is claimed two ways and neither is a client's word:
 *
 *   1. a DNS TXT record at `_cloud-wai-challenge.<hostname>` carrying the
 *      challenge token the control plane issued for that domain, or
 *   2. a CNAME from the hostname to this deployment's edge host, when one is
 *      configured — the same condition gate 6 ("direct origin access is denied")
 *      depends on.
 *
 * The rule this module exists to keep: `verified` is a fact observed on the wire,
 * not an input. There is no code path here that lets a caller assert it, and a
 * name whose records have not propagated comes back `verified: false` with the
 * reason — never `true` because a request asked for it.
 *
 * A DNS error that is *not* "no such record" (a timeout, a SERVFAIL, an
 * unreachable resolver) is reported as `degraded`, so a flaky lookup cannot be
 * mistaken for "definitely not verified" and silently pass a check it failed to
 * perform.
 */
import { err, ok, type AdapterResult } from "@cloud-wai/contracts";
import type { AdapterContext, DomainVerification, DomainVerifier } from "./index.js";

/** The TXT record name that carries the challenge. A fixed, documented prefix. */
export const CHALLENGE_PREFIX = "_cloud-wai-challenge";

/** The subset of `node:dns/promises` this adapter uses, injectable for tests. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
}

export interface DomainVerifierOptions {
  /** Injected for tests and for deployments with their own resolver. */
  readonly resolver?: DnsResolver;
  /**
   * The edge host a CNAME may point at. Absent means only a TXT match verifies,
   * so a deployment without an edge does not accept a CNAME it cannot inspect.
   */
  readonly edgeHostname?: string | undefined;
}

/** Default resolver backed by the platform's DNS. Loaded lazily (Node only). */
async function defaultResolver(): Promise<DnsResolver> {
  const dns = await import("node:dns/promises");
  return {
    resolveTxt: (hostname) => dns.resolveTxt(hostname).then((rows) => rows.map((r) => [...r])),
    resolveCname: (hostname) => dns.resolveCname(hostname),
  };
}

/** A resolver that reports every lookup as unavailable, for the unconfigured case. */
export function domainVerifierNotConfigured(engine: string, hint?: string): DomainVerifier {
  const miss = <T>(): Promise<AdapterResult<T>> =>
    Promise.resolve(
      err(
        "not_configured",
        `${engine} is not configured in this deployment.${hint ? ` ${hint}` : ""}`,
      ),
    );
  return { __notConfigured: true as const, resolveDomainVerification: miss };
}

/** DNS errors that mean "the record genuinely is not there", not "lookup broke". */
function isMissingRecord(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN";
}

export function createDnsDomainVerifier(options: DomainVerifierOptions = {}): DomainVerifier {
  const edgeHostname = options.edgeHostname?.trim().toLowerCase() || null;

  const resolve = async (input: { hostname: string; expectedToken: string }) => {
    const resolver = options.resolver ?? (await defaultResolver());
    const hostname = input.hostname.toLowerCase();

    // TXT first: the challenge proves control of the exact name, and does not
    // require the edge to be live.
    try {
      const rows = await resolver.resolveTxt(`${CHALLENGE_PREFIX}.${hostname}`);
      const flat = rows.map((parts) => parts.join(""));
      if (flat.some((value) => value.trim() === input.expectedToken)) {
        return ok("succeeded", {
          hostname,
          verified: true,
          provider: "dns",
          providerResourceId: null,
          detail: "The challenge TXT record matches the token issued for this domain.",
        });
      }
      return ok("succeeded", {
        hostname,
        verified: false,
        provider: "dns",
        providerResourceId: null,
        detail: `No TXT record at ${CHALLENGE_PREFIX}.${hostname} carries the expected token.`,
      });
    } catch (error) {
      if (!isMissingRecord(error)) {
        return err(
          "degraded",
          `The DNS lookup for ${CHALLENGE_PREFIX}.${hostname} did not complete.`,
        );
      }
      // Fall through to the CNAME check: ENODATA on TXT does not rule a CNAME out.
    }

    if (!edgeHostname) {
      return ok("succeeded", {
        hostname,
        verified: false,
        provider: "dns",
        providerResourceId: null,
        detail: "No challenge TXT record was found and no edge host is configured to match.",
      });
    }

    try {
      const targets = await resolver.resolveCname(hostname);
      const pointsAtEdge = targets.some(
        (target) => target.toLowerCase().replace(/\.$/, "") === edgeHostname,
      );
      if (pointsAtEdge) {
        return ok("succeeded", {
          hostname,
          verified: true,
          provider: "dns",
          providerResourceId: `${CHALLENGE_PREFIX}/${hostname}`,
          detail: `The hostname is a CNAME to the edge (${edgeHostname}).`,
        });
      }
      return ok("succeeded", {
        hostname,
        verified: false,
        provider: "dns",
        providerResourceId: null,
        detail: `The hostname is not a CNAME to the edge (${edgeHostname}) and no challenge record matched.`,
      });
    } catch (error) {
      if (isMissingRecord(error)) {
        return ok("succeeded", {
          hostname,
          verified: false,
          provider: "dns",
          providerResourceId: null,
          detail: "The hostname has no challenge TXT record and no CNAME to the edge.",
        });
      }
      return err("degraded", `The DNS lookup for ${hostname} did not complete.`);
    }
  };

  return {
    async resolveDomainVerification(ctx: AdapterContext, input) {
      const hostname = input.hostname.trim().toLowerCase();
      if (hostname === "" || !/^[a-z0-9.-]+$/.test(hostname)) {
        return err("failed", "Hostname is not a valid DNS name.");
      }
      return resolve({ hostname, expectedToken: input.expectedToken });
    },
  };
}
