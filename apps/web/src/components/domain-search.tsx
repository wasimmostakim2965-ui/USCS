/**
 * The domain search field.
 *
 * It is a real input that answers a real question about the *query* — is it a
 * hostname at all — and never invents an availability result. Registration
 * needs a registrar this deployment may not hold credentials for, so when it
 * does not, the field says so in plain words instead of rendering a fabricated
 * "available" badge. It belongs to the Domains surface, not the hero: a domain
 * is something you attach to an application, which is where the visitor meets
 * it.
 */
import { useId, useState } from "react";
import { Button, Icon } from "@cloud-wai/ui/react";

/** A hostname, so the answer can distinguish a bad query from an unconfigured one. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

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
  const [answer, setAnswer] = useState<string | null>(null);

  const submit = () => {
    const candidate = query.trim().toLowerCase();
    if (!candidate) {
      setAnswer(null);
      return;
    }
    if (!HOSTNAME.test(candidate)) {
      setAnswer(
        `“${query.trim()}” is not a hostname, so there is nothing to look up. A name like your-company.com is what this field expects.`,
      );
      return;
    }
    setAnswer(
      registrarConfigured
        ? `Cloud Wai would check ${candidate} against the configured registrar. This deployment has one wired up; the result appears here once the lookup returns.`
        : `Registrar lookup is not configured, so Cloud Wai cannot report whether ${candidate} is available. Point a registrar at this deployment and this field will answer for real.`,
    );
  };

  return (
    <form
      className="domain-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
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
            setAnswer(null);
          }}
        />
        <Button type="submit" variant="primary" disabled={query.trim() === ""}>
          Search
        </Button>
      </div>
      <p id={noteId} className="domain-search__note">
        {answer ??
          (registrarConfigured
            ? "Search runs against the registrar this deployment is configured with."
            : "Search is here; registrar lookup is not. This field answers about the query and never invents an availability result.")}
      </p>
    </form>
  );
}
