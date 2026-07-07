import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RAILWAY_GRAPHQL_URL,
  fetchEnvironmentLogs,
  fetchGrantedProjects,
  fetchProjectInventory,
  fetchServiceMetrics,
  fetchViewer,
  railwayGraphQL,
} from "./graphql.js";

function gqlResponder(data: unknown): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    gqlResponder.lastUrl = String(url);
    gqlResponder.lastBody = JSON.parse(String(init?.body));
    gqlResponder.lastAuth = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}
gqlResponder.lastUrl = "";
gqlResponder.lastBody = null as unknown;
gqlResponder.lastAuth = null as string | null;

test("railwayGraphQL sends a bearer-authed POST and surfaces Not Authorized", async () => {
  const ok = await railwayGraphQL({
    accessToken: "tok",
    query: "query { me { id } }",
    fetchImpl: gqlResponder({ me: { id: "u1" } }),
  });
  assert.ok(ok.ok);
  assert.equal(gqlResponder.lastUrl, RAILWAY_GRAPHQL_URL);
  assert.equal(gqlResponder.lastAuth, "Bearer tok");

  const denied = await railwayGraphQL({
    accessToken: "tok",
    query: "query { projects { edges { node { id } } } }",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }], data: null }), {
        status: 200,
      })) as typeof fetch,
  });
  assert.ok(!denied.ok);
  assert.equal(denied.notAuthorized, true);
});

test("fetchGrantedProjects flattens externalWorkspaces into granted projects", async () => {
  const result = await fetchGrantedProjects({
    accessToken: "tok",
    fetchImpl: gqlResponder({
      externalWorkspaces: [
        {
          id: "ws-1",
          name: "Superlog",
          projects: [
            { id: "p1", name: "blackbird" },
            { id: "p2", name: "neo" },
          ],
        },
      ],
    }),
  });
  assert.ok(result.ok);
  assert.deepEqual(result.projects, [
    { id: "p1", name: "blackbird", workspaceId: "ws-1", workspaceName: "Superlog" },
    { id: "p2", name: "neo", workspaceId: "ws-1", workspaceName: "Superlog" },
  ]);
});

test("fetchProjectInventory returns environments and services", async () => {
  const result = await fetchProjectInventory({
    accessToken: "tok",
    projectId: "p1",
    fetchImpl: gqlResponder({
      project: {
        id: "p1",
        name: "blackbird",
        environments: { edges: [{ node: { id: "env-1", name: "production" } }] },
        services: { edges: [{ node: { id: "svc-1", name: "blackbird-app" } }] },
      },
    }),
  });
  assert.ok(result.ok);
  assert.deepEqual(result.environments, [{ id: "env-1", name: "production" }]);
  assert.deepEqual(result.services, [{ id: "svc-1", name: "blackbird-app" }]);
});

test("fetchEnvironmentLogs paginates forward from the cursor", async () => {
  const result = await fetchEnvironmentLogs({
    accessToken: "tok",
    environmentId: "env-1",
    afterDate: "2026-07-07T14:10:31.058154105Z",
    limit: 500,
    fetchImpl: gqlResponder({
      environmentLogs: [
        {
          timestamp: "2026-07-07T14:10:32Z",
          severity: "info",
          message: "hello",
          tags: { serviceId: "svc-1" },
          attributes: [],
        },
      ],
    }),
  });
  assert.ok(result.ok);
  assert.equal(result.logs.length, 1);
  const body = gqlResponder.lastBody as { variables: Record<string, unknown> };
  assert.equal(body.variables.environmentId, "env-1");
  assert.equal(body.variables.afterDate, "2026-07-07T14:10:31.058154105Z");
  assert.equal(body.variables.afterLimit, 500);
});

test("fetchEnvironmentLogs reads backwards from the anchor when no cursor exists (first pull)", async () => {
  const result = await fetchEnvironmentLogs({
    accessToken: "tok",
    environmentId: "env-1",
    anchorDate: "2026-07-07T15:00:00.000Z",
    limit: 500,
    fetchImpl: gqlResponder({ environmentLogs: [] }),
  });
  assert.ok(result.ok);
  const body = gqlResponder.lastBody as { query: string; variables: Record<string, unknown> };
  assert.match(body.query, /anchorDate/);
  assert.match(body.query, /beforeLimit/);
  assert.equal(body.variables.anchorDate, "2026-07-07T15:00:00.000Z");
  assert.equal(body.variables.beforeLimit, 500);
  assert.equal(body.variables.afterDate, undefined);
});

test("fetchEnvironmentLogs drops malformed records instead of aborting the batch", async () => {
  const result = await fetchEnvironmentLogs({
    accessToken: "tok",
    environmentId: "env-1",
    afterDate: "2026-07-07T14:00:00Z",
    limit: 100,
    fetchImpl: gqlResponder({
      environmentLogs: [
        // attributes missing entirely; tags is a string — both normalized.
        { timestamp: "2026-07-07T14:01:00Z", severity: "info", message: "ok", tags: "bogus" },
        // no timestamp → dropped.
        { severity: "info", message: "no-ts" },
        null,
      ],
    }),
  });
  assert.ok(result.ok);
  assert.equal(result.logs.length, 1);
  assert.deepEqual(result.logs[0], {
    timestamp: "2026-07-07T14:01:00Z",
    severity: "info",
    message: "ok",
    tags: null,
    attributes: [],
  });
});

test("fetchServiceMetrics requests the infra measurements", async () => {
  const result = await fetchServiceMetrics({
    accessToken: "tok",
    environmentId: "env-1",
    serviceId: "svc-1",
    startDate: "2026-07-07T13:00:00Z",
    endDate: "2026-07-07T14:00:00Z",
    sampleRateSeconds: 60,
    fetchImpl: gqlResponder({
      metrics: [
        { measurement: "CPU_USAGE", values: [{ ts: 1, value: 0.5 }], tags: { serviceId: "svc-1" } },
      ],
    }),
  });
  assert.ok(result.ok);
  assert.equal(result.results.length, 1);
  const body = gqlResponder.lastBody as { variables: Record<string, unknown> };
  assert.equal(body.variables.serviceId, "svc-1");
  assert.ok(Array.isArray(body.variables.measurements));
});

test("fetchViewer returns the Railway user for install keying", async () => {
  const result = await fetchViewer({
    accessToken: "tok",
    fetchImpl: gqlResponder({ me: { id: "u1", name: "Ash", email: "a@b.c" } }),
  });
  assert.ok(result.ok);
  assert.equal(result.viewer.id, "u1");
});
