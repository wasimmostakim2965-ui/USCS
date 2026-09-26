/**
 * The engine-console deep link: verified against the engine's real routes.
 *
 * ADR-0011 (Option A) makes the Database section a control-plane view that points
 * at the engine's own console instead of querying the tenant data plane. That
 * makes this URL builder a user-visible contract, so it is checked against the
 * pinned Coolify *console* route table rather than trusted: a suffix here that
 * Coolify does not serve would be a link to a 404.
 *
 * The refusals matter as much as the successes. A link is only built when every
 * identifier is present and well-formed, because a half-built link is worse than
 * an honest "not configured" — it looks like a working control and lands on an
 * error page.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONSOLE_SECTIONS,
  DATABASE_CONSOLE_PREFIX,
  createEngineConsoleLinker,
  engineConsoleUrl,
  type ConsoleSection,
} from "@cloud-wai/adapters";

const ORIGIN = "https://coolify.example.com";
// 20+ characters, alphanumeric: Coolify's CUID shape.
const PROJECT = "pk0sk0w8w0s4c0s0k4w8c8ss";
const ENVIRONMENT = "ek0sk0w8w0s4c0s0k4w8c8ss";
const DATABASE = "dk0sk0w8w0s4c0s0k4w8c8ss";

const infra = { projectUuid: PROJECT, environmentUuid: ENVIRONMENT };

const base = {
  baseUrl: ORIGIN,
  provider: "postgres",
  resourceKind: "postgres" as const,
  resourceUuid: DATABASE,
  infra,
};

describe("engineConsoleUrl", () => {
  it("builds the overview link from the pinned prefix", () => {
    const url = engineConsoleUrl(base);
    expect(url).toBe(
      `${ORIGIN}/project/${PROJECT}/environment/${ENVIRONMENT}/database/${DATABASE}`,
    );
  });

  it("appends the section suffix for every section it names", () => {
    for (const section of CONSOLE_SECTIONS) {
      const url = engineConsoleUrl({ ...base, section });
      expect(url, section).not.toBeNull();
      expect(url!.startsWith(`${ORIGIN}${DATABASE_CONSOLE_PREFIX.split("{")[0]}`)).toBe(true);
    }
  });

  it("defaults to the overview route when no section is given", () => {
    expect(engineConsoleUrl(base)).toBe(engineConsoleUrl({ ...base, section: "overview" }));
  });

  it("drops a trailing slash on the origin so the path cannot double up", () => {
    expect(engineConsoleUrl({ ...base, baseUrl: `${ORIGIN}/` })).toBe(
      `${ORIGIN}/project/${PROJECT}/environment/${ENVIRONMENT}/database/${DATABASE}`,
    );
  });

  describe("refuses to build a link it cannot stand behind", () => {
    it("returns null without a console origin", () => {
      expect(engineConsoleUrl({ ...base, baseUrl: undefined })).toBeNull();
      expect(engineConsoleUrl({ ...base, baseUrl: "" })).toBeNull();
      expect(engineConsoleUrl({ ...base, baseUrl: "   " })).toBeNull();
    });

    it("returns null for a bucket, which the storage engine serves instead", () => {
      expect(engineConsoleUrl({ ...base, resourceKind: "object_storage" })).toBeNull();
    });

    it("returns null when the engine has not named the resource yet", () => {
      expect(engineConsoleUrl({ ...base, resourceUuid: null })).toBeNull();
      expect(engineConsoleUrl({ ...base, resourceUuid: "" })).toBeNull();
    });

    it("returns null when the placement is missing or named by name, not uuid", () => {
      expect(engineConsoleUrl({ ...base, infra: undefined })).toBeNull();
      expect(engineConsoleUrl({ ...base, infra: { projectUuid: PROJECT } })).toBeNull();
      expect(
        engineConsoleUrl({
          ...base,
          infra: { projectUuid: PROJECT, environmentName: "production" },
        }),
      ).toBeNull();
    });

    it("refuses a malformed identifier rather than putting it in a path", () => {
      expect(engineConsoleUrl({ ...base, resourceUuid: "../../admin" })).toBeNull();
      expect(engineConsoleUrl({ ...base, resourceUuid: "short" })).toBeNull();
      expect(
        engineConsoleUrl({ ...base, infra: { ...infra, projectUuid: "a/b/c/d/e/f/g/h/i/j/k/l" } }),
      ).toBeNull();
    });

    it("refuses a non-http origin, so a link cannot be a script URL", () => {
      expect(engineConsoleUrl({ ...base, baseUrl: "javascript:alert(1)" })).toBeNull();
      expect(engineConsoleUrl({ ...base, baseUrl: "data:text/html,<script>" })).toBeNull();
      expect(engineConsoleUrl({ ...base, baseUrl: "not a url" })).toBeNull();
    });

    it("returns null for a provider whose console this build does not know", () => {
      expect(engineConsoleUrl({ ...base, provider: "minio" })).toBeNull();
      expect(engineConsoleUrl({ ...base, provider: null })).toBeNull();
    });
  });
});

describe("the console suffixes exist in the pinned Coolify console route table", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/coolify-console-routes.json", import.meta.url), "utf8"),
  ) as { _commit: string; databaseRoutes: string[] };

  /** The fixture stores placeholder paths; expand one the way a link is built. */
  const expandFixturePath = (path: string) =>
    path
      .replace("{project_uuid}", PROJECT)
      .replace("{environment_uuid}", ENVIRONMENT)
      .replace("{database_uuid}", DATABASE);

  it("pins the same Coolify commit as the API route fixture", () => {
    expect(fixture._commit).toBe("7c86e53422ad7c4f19c5821621c71403b9173f62");
    expect(fixture.databaseRoutes.length).toBeGreaterThan(15);
  });

  it("serves every section this module can link to", () => {
    const served = new Set(fixture.databaseRoutes.map(expandFixturePath));
    for (const section of CONSOLE_SECTIONS) {
      const link = engineConsoleUrl({ ...base, section });
      expect(link, section).not.toBeNull();
      const path = link!.slice(ORIGIN.length);
      expect(
        served.has(path),
        `${section} -> ${path} is not in the pinned Coolify console route table`,
      ).toBe(true);
    }
  });

  it("names each section with a distinct suffix, so no two links collide", () => {
    // A guard on the guard: if two sections mapped to one suffix, the per-section
    // check above would still pass while the dashboard sent two different pages
    // to one URL.
    const links = CONSOLE_SECTIONS.map((section) => engineConsoleUrl({ ...base, section }));
    expect(new Set(links).size).toBe(CONSOLE_SECTIONS.length);
  });
});

describe("createEngineConsoleLinker", () => {
  const orgEnv = {
    ENGINE_CONSOLE_URL: ORIGIN,
    [`COOLIFY_PROJECT_UUID__org-a`]: PROJECT,
    [`COOLIFY_ENVIRONMENT_UUID__org-a`]: ENVIRONMENT,
  };
  const resource = {
    provider: "postgres",
    kind: "postgres" as const,
    providerResourceId: DATABASE,
  };

  it("is undefined when no console origin is configured", () => {
    expect(createEngineConsoleLinker({})).toBeUndefined();
    expect(createEngineConsoleLinker({ ENGINE_CONSOLE_URL: "  " })).toBeUndefined();
  });

  it("builds a link for the tenant whose placement is configured", () => {
    const link = createEngineConsoleLinker(orgEnv)!;
    const built = link({ organizationId: "org-a", resource });
    expect(built).not.toBeNull();
    const prefix = `${ORIGIN}/project/${PROJECT}/environment/${ENVIRONMENT}/database/${DATABASE}`;
    expect(built!.overview).toBe(prefix);
    expect(built!.logs).toBe(`${prefix}/logs`);
    expect(built!.terminal).toBe(`${prefix}/terminal`);
    // Every section the module names is present, so a page cannot pick a key
    // that the record forgot to fill in.
    expect(Object.keys(built!).sort()).toEqual([...CONSOLE_SECTIONS].sort());
  });

  it("gives one tenant no link when only another tenant is placed", () => {
    // The tenant boundary: org-b's identifiers are not on org-a's credential
    // record, so org-a's resource gets null rather than org-b's path.
    const link = createEngineConsoleLinker(orgEnv)!;
    expect(link({ organizationId: "org-b", resource })).toBeNull();
  });

  it("does not fall back to the environment name, which the path cannot use", () => {
    const link = createEngineConsoleLinker({
      ENGINE_CONSOLE_URL: ORIGIN,
      [`COOLIFY_PROJECT_UUID__org-a`]: PROJECT,
      [`COOLIFY_ENVIRONMENT_NAME__org-a`]: "production",
    })!;
    expect(link({ organizationId: "org-a", resource })).toBeNull();
  });

  it("gives a bucket no link, because the storage engine serves it", () => {
    const link = createEngineConsoleLinker(orgEnv)!;
    expect(
      link({
        organizationId: "org-a",
        resource: { provider: "minio", kind: "object_storage", providerResourceId: DATABASE },
      }),
    ).toBeNull();
  });

  it("returns the whole link set or nothing, never one working link and one dead", () => {
    // A resource the engine has not named yet: both halves are unbuildable, and
    // the object is null rather than `{ resource: null, logs: null }`.
    const link = createEngineConsoleLinker(orgEnv)!;
    expect(
      link({
        organizationId: "org-a",
        resource: { provider: "postgres", kind: "postgres", providerResourceId: null },
      }),
    ).toBeNull();
  });
});
