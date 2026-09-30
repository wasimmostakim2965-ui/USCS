/**
 * The hostname field on the Domains surface.
 *
 * It answers a real question about the *query* — is it a hostname at all — and
 * then tells the operator exactly how to attach it. Cloud Wai does not register,
 * buy or renew names: a domain is one the customer already owns, attached and
 * confirmed by DNS. So there is no availability lookup and no price here, and no
 * button that would imply a purchase this deployment cannot make.
 *
 * The shape is a single hostname, not a registrar's extension sweep: offering
 * ".com/.net/.org" candidates would read as "we can sell you these", which is
 * precisely the promise the platform does not make.
 */
import { useId, useMemo, useState } from "react";
import { Button, Icon } from "@cloud-wai/ui/react";

/** A hostname, so the answer can distinguish a bad query from a valid one. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lower-case, scheme- and path-stripped, the form a lookup would actually use. */
function normalizeQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/** The single hostname a query names, or null when it is not a hostname. */
export function domainCandidate(raw: string): string | null {
  const query = normalizeQuery(raw);
  return HOSTNAME.test(query) ? query : null;
}

export function DomainSearch() {
  const inputId = useId();
  const noteId = `${inputId}-note`;
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);

  const candidate = useMemo(
    () => (submitted === null ? null : domainCandidate(submitted)),
    [submitted],
  );

  const answer = useMemo(() => {
    if (submitted === null) return null;
    if (normalizeQuery(submitted) === "") return null;
    if (candidate === null) {
      return `“${submitted.trim()}” is not a hostname, so there is nothing to attach. A name like your-company.com is what this field expects.`;
    }
    return `Add ${candidate} below. Cloud Wai records it unverified and returns a DNS TXT record to publish; the edge confirms the name once the record resolves. A domain you already own is all that is needed — nothing is bought here.`;
  }, [submitted, candidate]);

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
        Attach a domain you own
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
          Check
        </Button>
      </div>

      <p id={noteId} className="domain-search__note">
        {answer ??
          "Type a hostname you already own. This field checks the shape of the name and tells you how it attaches; it never invents an availability result or a price."}
      </p>
    </form>
  );
}
