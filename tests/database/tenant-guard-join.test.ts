/**
 * The tenant guard must be a *joinable* PostgREST filter.
 *
 * Every membership-scoped read and write re-asserts the caller's membership as
 * a dotted filter — `organization_members.user_id=eq.<caller>` — so a
 * service-role connection cannot reach across a tenant. PostgREST does not
 * accept a dotted filter on its own: the embedded resource must appear in
 * `select`, or PostgREST answers PGRST108 and the request fails outright.
 *
 * The existing store tests once used a stand-in that *skipped* dotted keys
 * instead of modelling this, so the whole control plane shipped with queries a
 * real PostgREST rejects while the suite stayed green. This test models the
 * PostgREST rule instead, so the guard cannot silently stop being joinable.
 */
import { describe, expect, it } from "vitest";
import { createPostgrestClient, createSupabaseControlPlaneStore } from "@cloud-wai/database";
import type { DeploymentId, OrganizationId, ProjectId } from "@cloud-wai/contracts";

type Row = Record<string, unknown>;

const ORG = "11111111-1111-4111-8111-111111111111" as OrganizationId;
const PROJ = "22222222-2222-4222-8222-222222222222" as ProjectId;
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const DEP = "55555555-5555-4555-8555-555555555555" as DeploymentId;

const deploymentRow = (organizationId: string, id: string): Row => ({
  id,
  project_id: PROJ,
  organization_id: organizationId,
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
  created_at: "2026-01-01T00:00:01.000Z",
  updated_at: "2026-01-01T00:00:01.000Z",
});

/**
 * A PostgREST stand-in that enforces the embed rule for dotted filters.
 *
 * A dotted filter names a resource the request must embed. The first segment is
 * matched against the `select` list; a dotted filter on a resource the request
 * did not embed is rejected exactly as PostgREST rejects it (400 PGRST108).
 * Because every table either *is* the organization, or carries
 * `organization_id`, the join is modelled directly: a membership filter is
 * satisfied when the organization has a matching `organization_members` row.
 */
function fakePostgrest(tables: Record<string, Row[]>) {
  const requests: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = String(url).replace(/^.*\/rest\/v1/, "");
    requests.push(path);
    const [table, query = ""] = path.replace(/^\//, "").split("?");
    const parts = query.split("&");

    const selectPart = parts.find((p) => p.startsWith("select="));
    const select = selectPart ? selectPart.slice("select=".length) : "";
    const embeds = select.split(",").map((s) => s.split(/[(!]/)[0] ?? "");

    const plain: { key: string; want: string }[] = [];
    const joins: { embedded: string; column: string; want: string }[] = [];

    for (const part of parts) {
      const [key, raw] = part.split("=");
      if (!key || raw === undefined || !raw.startsWith("eq.")) continue;
      const want = decodeURIComponent(raw.slice(3));
      if (key.includes(".")) {
        const segments = key.split(".");
        const embedded = segments[0] ?? "";
        // The embed must be selected, or PostgREST refuses the request.
        if (!embeds.includes(embedded)) {
          return new Response(
            JSON.stringify({
              code: "PGRST108",
              message: `'${embedded}' is not an embedded resource in this request`,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        joins.push({ embedded, column: segments[segments.length - 1] ?? "", want });
        continue;
      }
      plain.push({ key, want });
    }

    const rows = tables[table ?? ""] ?? [];
    const members = tables["organization_members"] ?? [];
    const membershipFor = (organizationId: unknown, column: string, want: string) =>
      members.some(
        (m) =>
          String(m["organization_id"]) === String(organizationId) && String(m[column]) === want,
      );

    const matched = rows.filter(
      (row) =>
        plain.every(({ key, want }) => String(row[key]) === want) &&
        joins.every(({ column, want }) => membershipFor(row["organization_id"], column, want)),
    );

    return new Response(JSON.stringify(matched), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function storeOver() {
  const { fetchImpl, requests } = fakePostgrest({
    deployments: [deploymentRow(ORG, DEP)],
    organization_members: [
      { organization_id: ORG, user_id: USER, role: "owner" },
      { organization_id: ORG, user_id: OTHER, role: "viewer" },
    ],
  });
  const client = createPostgrestClient({
    url: "https://db.test",
    serviceRoleKey: "service-role",
    fetchImpl,
  });
  return { store: createSupabaseControlPlaneStore({ client, newId: () => "new-id" }), requests };
}

describe("the tenant guard is a joinable filter", () => {
  it("returns rows to a member through the embedded membership join", async () => {
    const { store, requests } = storeOver();
    const found = await store.listDeployments(USER, PROJ);
    expect(found.map((d) => d.id)).toEqual([DEP]);
    // The select must carry the embed the dotted filter needs, or PostgREST
    // would have refused the request (it would have thrown, not returned []).
    expect(requests[0]).toContain("organizations!inner(organization_members!inner(user_id))");
  });

  it("does not return another tenant's rows", async () => {
    const { store } = storeOver();
    // A user in no organization matches no membership row.
    const found = await store.listDeployments("99999999-9999-4999-8999-999999999999", PROJ);
    expect(found).toEqual([]);
  });

  it("resolves memberships through the joinable guard too", async () => {
    const { store, requests } = storeOver();
    const found = await store.membershipsFor(USER);
    expect(found.map((m) => m.organizationId)).toEqual([ORG]);
    // Membership resolution is a scoped read like any other: the same
    // `organizations!inner(organization_members!inner(user_id))` guard must be
    // present, or a real PostgREST refuses the dotted filter (PGRST108).
    expect(requests[0]).toContain("organizations!inner(organization_members!inner(user_id))");
  });

  it("returns no memberships for a user whose organization does not back them", async () => {
    const { store } = storeOver();
    const found = await store.membershipsFor("99999999-9999-4999-8999-999999999999");
    expect(found).toEqual([]);
  });
});
