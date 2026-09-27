/**
 * Keyset pagination on the append-ordered lists (audit finding C4).
 *
 * The store used to issue a fixed `limit` with no cursor, so a page could only
 * ever show the newest N rows and there was no way to walk further back. These
 * drive the *store* over an in-process PostgREST stand-in that honours the same
 * operators PostgREST does (`eq.`, `lt.`, `order`, `limit`), so the assertions
 * are about the emitted query and its effect, not about a stub that returns the
 * answer the test wanted.
 */
import { describe, expect, it } from "vitest";
import {
  createPostgrestClient,
  createSupabaseControlPlaneStore,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  resolveListLimit,
  type Deployment,
} from "@cloud-wai/database";
import type { AuditEvent, OrganizationId, ProjectId } from "@cloud-wai/contracts";

const PROJ = "p-1" as ProjectId;
const ORG = "org-a" as OrganizationId;
const USER = "u-1";

type Row = Record<string, unknown>;

/**
 * A PostgREST stand-in that applies `eq.`, `lt.`, `order=created_at.desc` and
 * `limit`, in that order — the same shape PostgREST applies.
 */
function fakePostgrest(tables: Record<string, Row[]>) {
  const paths: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = (url as string).replace(/^.*\/rest\/v1/, "");
    paths.push(path);
    const [table, query = ""] = path.replace(/^\//, "").split("?");
    let matched = [...(tables[table ?? ""] ?? [])];

    for (const part of query.split("&")) {
      const [key, raw] = part.split("=");
      if (!key || raw === undefined) continue;
      // A dotted key (`organization_members.user_id`) is an embedded-resource
      // filter — a join in PostgREST — not a column on this row, so it is not
      // applied to the row's own fields here.
      if (key.includes(".")) continue;
      if (raw.startsWith("eq.")) {
        const want = decodeURIComponent(raw.slice(3));
        matched = matched.filter((row) => String(row[key]) === want);
      } else if (raw.startsWith("lt.")) {
        const bound = decodeURIComponent(raw.slice(3));
        matched = matched.filter((row) => String(row[key]) < bound);
      }
    }
    if (query.includes("order=created_at.desc")) {
      matched.sort((a, b) => String(b["created_at"]).localeCompare(String(a["created_at"])));
    }
    const limit = /(?:^|&)limit=(\d+)/.exec(query);
    if (limit) matched = matched.slice(0, Number(limit[1]));

    return new Response(JSON.stringify(matched), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, paths };
}

function storeOver(rows: Row[]) {
  const { fetchImpl, paths } = fakePostgrest({ deployments: rows, audit_logs: rows });
  const client = createPostgrestClient({
    url: "https://db.test",
    serviceRoleKey: "service-role",
    fetchImpl,
  });
  return { store: createSupabaseControlPlaneStore({ client, newId: () => "new-id" }), paths };
}

const deploymentRow = (iso: string): Row => ({
  id: `dep-${iso}`,
  project_id: PROJ,
  organization_id: ORG,
  environment: "production",
  status: "succeeded",
  url: null,
  commit_sha: null,
  provider: null,
  provider_resource_id: null,
  rollback_of: null,
  source: null,
  is_staged: false,
  promoted_at: null,
  root_directory: null,
  created_at: iso,
  updated_at: iso,
});

const auditRow = (iso: string): Row => ({
  id: `aud-${iso}`,
  organization_id: ORG,
  actor_id: USER,
  action: "project.created",
  target_type: "project",
  target_id: "p-1",
  metadata: {},
  created_at: iso,
});

/** 5 rows, one second apart, oldest first as stored. */
const deploymentRows = ["01", "02", "03", "04", "05"].map((s) =>
  deploymentRow(`2026-01-01T00:00:${s}.000Z`),
);
const freshDeploys = () => storeOver(deploymentRows);

describe("list pagination", () => {
  it("defaults the page size instead of asking for the whole table", async () => {
    const { store, paths } = freshDeploys();
    await store.listDeployments(USER, PROJ);
    expect(paths[0]).toContain(`limit=${DEFAULT_LIST_LIMIT}`);
  });

  it("clamps a caller's oversized limit to the store maximum", async () => {
    const { store, paths } = freshDeploys();
    const page = await store.listDeployments(USER, PROJ, { limit: 100_000 });
    expect(paths[0]).toContain(`limit=${MAX_LIST_LIMIT}`);
    expect(page.length).toBeLessThanOrEqual(MAX_LIST_LIMIT);
  });

  it("treats a non-positive or fractional limit as absent", () => {
    expect(resolveListLimit(0, 7)).toBe(7);
    expect(resolveListLimit(-5, 7)).toBe(7);
    expect(resolveListLimit(2.5, 7)).toBe(7);
    expect(resolveListLimit(3, 7)).toBe(3);
    expect(resolveListLimit(undefined, 7)).toBe(7);
  });

  it("returns the newest page first", async () => {
    const { store } = freshDeploys();
    const page = await store.listDeployments(USER, PROJ, { limit: 2 });
    expect(page.map((d: Deployment) => d.createdAt)).toEqual([
      "2026-01-01T00:00:05.000Z",
      "2026-01-01T00:00:04.000Z",
    ]);
  });

  it("walks every row exactly once with a keyset cursor under inserts at the head", async () => {
    const { store, paths } = freshDeploys();
    const seen: string[] = [];
    let before: string | undefined;
    // A new deployment lands at the head between page 1 and page 2. An offset
    // would repeat the row it pushed down; a keyset cannot.
    for (let page = 0; page < 4; page += 1) {
      const rows = await store.listDeployments(USER, PROJ, {
        limit: 2,
        ...(before !== undefined ? { before } : {}),
      });
      seen.push(...rows.map((d: Deployment) => d.createdAt));
      if (rows.length === 0) break;
      before = rows[rows.length - 1]?.createdAt;
      await store.listDeployments(USER, PROJ, { limit: 1 });
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([
      "2026-01-01T00:00:05.000Z",
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:01.000Z",
    ]);
    // The cursor is an explicit `lt.` filter, not an offset.
    expect(paths.some((p) => p.includes("created_at=lt."))).toBe(true);
    expect(paths.every((p) => !p.includes("offset="))).toBe(true);
  });

  it("paginates the audit log with the same cursor semantics", async () => {
    const store = storeOver(["01", "02", "03"].map((s) => auditRow(`2026-01-01T00:00:${s}.000Z`)));
    const first = await store.store.listAuditEvents(USER, ORG, { limit: 2 });
    expect(first.map((e: AuditEvent) => e.createdAt)).toEqual([
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:02.000Z",
    ]);
    const second = await store.store.listAuditEvents(USER, ORG, {
      limit: 2,
      before: first[first.length - 1]?.createdAt,
    });
    expect(second.map((e: AuditEvent) => e.createdAt)).toEqual(["2026-01-01T00:00:01.000Z"]);
  });

  it("still scopes every page by tenant", async () => {
    const { store, paths } = freshDeploys();
    await store.listDeployments(USER, PROJ, { before: "2026-01-01T00:00:04.000Z" });
    expect(paths[0]).toContain(`project_id=eq.${PROJ}`);
    expect(paths[0]).toContain(`organization_members.user_id=eq.${USER}`);
  });
});
