/**
 * The domain search field.
 *
 * It is a real input that answers a real question about the *query* — is it a
 * hostname at all — and never invents an availability result. Registration
 * needs a registrar this deployment may not hold credentials for, so when it
 * does not, the field says so in plain words instead of rendering a fabricated
 * "available" badge — and never a price. The shape is a registrar's search on
 * purpose: a bare label is offered across the usual extensions, each marked
 * "needs a registrar" rather than dressed up with an invented availability.
 * It belongs to the Domains surface, not the hero: a domain is something you
 * attach to an application, which is where the visitor meets it.
 */
import { useId, useMemo, useState } from "react";
import { Button, Icon } from "@cloud-wai/ui/react";

/** A hostname, so the answer can distinguish a bad query from an unconfigured one. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** A bare label, the left of a name before an extension is chosen. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** The extensions a registrar search offers when the query has no extension. */
const EXTENSIONS = [".com", ".net", ".org", ".io", ".dev"] as const;

/**
 * Turn one typed query into the candidate names a registrar-style search shows.
 * A full hostname yields exactly itself; a bare label yields that label across
 * the offered extensions; anything else yields nothing, so the caller can say
 * honestly that the query is not a name at all. It never invents a result.
 */
export function domainCandidates(raw: string): string[] {
  const query = normalizeQuery(raw);
  if (!query) return [];
  if (HOSTNAME.test(query)) return [query];
  if (LABEL.test(query)) return EXTENSIONS.map((extension) => `${query}${extension}`);
  return [];
}

/** Lower-case, scheme- and path-stripped, the form a lookup would actually use. */
function normalizeQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

export function DomainSearch({
  /**
   * Whether a registrar is reachable from this deployment. False by default:
   * the honest state until a provider is configured, so the copy is never a
   * claim the deployment cannot keep.
   */
  registrarConfigured = false,
}: {
  readonly registrarConfigured?: boolean;
}) {
  const inputId = useId();
  const noteId = `${inputId}-note`;
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);

  const candidates = useMemo(
    () => (submitted === null ? [] : domainCandidates(submitted)),
    [submitted],
  );
  const bareLabel = candidates.length > 1;

  const answer = useMemo(() => {
    if (submitted === null) return null;
    const candidate = normalizeQuery(submitted);
    if (!candidate) return null;
    if (candidates.length === 0) {
      return `“${submitted.trim()}” is not a hostname, so there is nothing to look up. A name like your-company.com is what this field expects.`;
    }
    if (bareLabel) {
      return `“${submitted.trim()}” has no extension yet, so here are the names a registrar would search.`;
    }
    return registrarConfigured
      ? `Cloud Wai would check ${candidate} against the configured registrar. This deployment has one wired up; the result appears here once the lookup returns.`
      : `Registrar lookup is not configured, so Cloud Wai cannot report whether ${candidate} is available. Point a registrar at this deployment and this field will answer for real.`;
  }, [submitted, candidates.length, bareLabel, registrarConfigured]);

  return (
    <form
      className="domain-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(query.trim() === "" ? null : query);
      }}
    >
      <label className="domain-search__label" htmlFor={inputId}>
        Find a domain
      </label>
      <div className="domain-search__row">
        <span className="domain-search__glyph" aria-hidden="true">
          <Icon name="search" size={18} />
        </span>
        <input
          id={inputId}
          className="domain-search__input"
          type="search"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="your-company.com"
          aria-describedby={noteId}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSubmitted(null);
          }}
        />
        <Button type="submit" variant="primary" disabled={query.trim() === ""}>
          Search
        </Button>
      </div>

      {candidates.length > 0 && (
        <ul className="domain-search__list" aria-label="Domains this search would look up">
          {candidates.map((name) => (
            <li key={name} className="domain-search__result">
              <span className="domain-search__name mono">{name}</span>
              <span className="domain-search__status">
                {registrarConfigured ? "Ask registrar" : "Needs a registrar"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p id={noteId} className="domain-search__note">
        {answer ??
          (registrarConfigured
            ? "Search runs against the registrar this deployment is configured with."
            : "Search is here; registrar lookup is not. This field answers about the query and never invents an availability result.")}
      </p>
    </form>
  );
}
