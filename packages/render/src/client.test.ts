import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FetchImpl,
  fetchLogs,
  fetchMetrics,
  fetchOwners,
  fetchServices,
  seriesResourceId,
} from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Recording fetch stub: replies from a queue and captures each request URL.
function fetchStub(responses: Response[]): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const queue = [...responses];
  const impl: FetchImpl = async (input) => {
    urls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error("fetch stub exhausted");
    return next;
  };
  return { impl, urls };
}

test("fetchOwners lists workspaces and sends the bearer key", async () => {
  const captured: RequestInit[] = [];
  const impl: FetchImpl = async (_input, init) => {
    captured.push(init ?? {});
    return jsonResponse([
      { owner: { id: "tea-1", name: "Acme", email: "ops@acme.dev", type: "team" }, cursor: "c1" },
      { owner: { id: "usr-1", name: "Jane", email: null, type: "user" }, cursor: "c2" },
      { owner: null, cursor: "c3" },
    ]);
  };
  const result = await fetchOwners({ apiKey: "rnd_key", fetchImpl: impl });
  assert.ok(result.ok);
  assert.deepEqual(
    result.owners.map((o) => o.id),
    ["tea-1", "usr-1"],
  );
  const headers = captured[0]?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer rnd_key");
});

test("fetchOwners reports an invalid key as unauthorized", async () => {
  const { impl } = fetchStub([jsonResponse({ message: "unauthorized" }, 401)]);
  const result = await fetchOwners({ apiKey: "bad", fetchImpl: impl });
  assert.ok(!result.ok);
  assert.equal(result.unauthorized, true);
});

test("fetchServices paginates with cursors and normalizes services", async () => {
  const pageOne = Array.from({ length: 100 }, (_, i) => ({
    service: {
      id: `srv-${i}`,
      name: `svc-${i}`,
      type: "web_service",
      suspended: "not_suspended",
      serviceDetails: { region: "oregon" },
    },
    cursor: `cur-${i}`,
  }));
  const pageTwo = [
    {
      service: { id: "srv-x", name: "worker", type: "background_worker", suspended: "suspended" },
      cursor: "cur-x",
    },
  ];
  const { impl, urls } = fetchStub([jsonResponse(pageOne), jsonResponse(pageTwo)]);
  const result = await fetchServices({ apiKey: "k", ownerId: "tea-1", fetchImpl: impl });
  assert.ok(result.ok);
  assert.equal(result.services.length, 101);
  assert.equal(result.services[0]?.region, "oregon");
  assert.equal(result.services[100]?.suspended, true);
  assert.equal(result.services[100]?.region, null);
  assert.equal(urls.length, 2);
  assert.ok(urls[0]?.includes("ownerId=tea-1"));
  assert.ok(urls[1]?.includes("cursor=cur-99"));
});

test("fetchLogs builds the query and normalizes the page", async () => {
  const { impl, urls } = fetchStub([
    jsonResponse({
      hasMore: true,
      nextStartTime: "2026-07-07T14:11:00Z",
      nextEndTime: "2026-07-07T14:12:00Z",
      logs: [
        {
          id: "log-1",
          timestamp: "2026-07-07T14:10:31Z",
          message: "hello",
          labels: [{ name: "resource", value: "srv-1" }],
        },
        { message: "no timestamp → dropped" },
      ],
    }),
  ]);
  const result = await fetchLogs({
    apiKey: "k",
    ownerId: "tea-1",
    resources: ["srv-1", "srv-2"],
    startTime: "2026-07-07T14:00:00Z",
    direction: "forward",
    limit: 100,
    fetchImpl: impl,
  });
  assert.ok(result.ok);
  assert.equal(result.page.logs.length, 1);
  assert.equal(result.page.logs[0]?.id, "log-1");
  assert.equal(result.page.hasMore, true);
  assert.equal(result.page.nextStartTime, "2026-07-07T14:11:00Z");
  const url = new URL(urls[0] ?? "");
  assert.equal(url.pathname, "/v1/logs");
  assert.deepEqual(url.searchParams.getAll("resource"), ["srv-1", "srv-2"]);
  assert.equal(url.searchParams.get("direction"), "forward");
  assert.equal(url.searchParams.get("limit"), "100");
});

test("fetchMetrics normalizes series defensively", async () => {
  const { impl, urls } = fetchStub([
    jsonResponse([
      {
        labels: [{ field: "resource", value: "srv-1" }],
        unit: "GB",
        values: [
          { timestamp: "2026-07-07T14:10:00Z", value: 0.5 },
          { timestamp: "2026-07-07T14:11:00Z", value: "garbage" },
        ],
      },
      "not a series",
    ]),
  ]);
  const result = await fetchMetrics({
    apiKey: "k",
    kind: "memory",
    resources: ["srv-1"],
    startTime: "2026-07-07T14:00:00Z",
    endTime: "2026-07-07T14:15:00Z",
    resolutionSeconds: 60,
    fetchImpl: impl,
  });
  assert.ok(result.ok);
  // The malformed entry is dropped; the garbage value inside the good series too.
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0]?.values.length, 1);
  assert.equal(
    seriesResourceId(result.series[0] ?? { labels: [], unit: null, values: [] }),
    "srv-1",
  );
  const url = new URL(urls[0] ?? "");
  assert.equal(url.pathname, "/v1/metrics/memory");
  assert.equal(url.searchParams.get("resolutionSeconds"), "60");
});

test("network failure surfaces as an error, not a throw", async () => {
  const impl: FetchImpl = async () => {
    throw new Error("ECONNRESET");
  };
  const result = await fetchLogs({
    apiKey: "k",
    ownerId: "tea-1",
    resources: ["srv-1"],
    limit: 20,
    fetchImpl: impl,
  });
  assert.ok(!result.ok);
  assert.equal(result.error, "ECONNRESET");
});
