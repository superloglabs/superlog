import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { countSeries } from "./index.js";

test("countSeries filters log counts by per-record attributes", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};
  const ch = {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      capture.query = input.query;
      capture.params = input.query_params;
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;

  await countSeries(
    ch,
    "project-1",
    "logs",
    {
      range: { since: "2026-08-06T10:00:00.000Z", until: "2026-08-06T10:15:00.000Z" },
      logAttrs: [
        { key: "gcp.http_request.status", value: "422" },
        { key: "gcp.http_request.requestUrl", value: "/api/captains/stripe/connect" },
      ],
    },
    undefined,
    { n: 15, unit: "MINUTE" },
  );

  assert.match(capture.query ?? "", /LogAttributes\[\{event_attr_k_0:String\}\]/);
  assert.match(capture.query ?? "", /LogAttributes\[\{event_attr_k_1:String\}\]/);
  assert.equal(capture.params?.event_attr_k_0, "gcp.http_request.status");
  assert.equal(capture.params?.event_attr_v_0, "422");
  assert.equal(capture.params?.event_attr_k_1, "gcp.http_request.requestUrl");
  assert.equal(capture.params?.event_attr_v_1, "/api/captains/stripe/connect");
});
