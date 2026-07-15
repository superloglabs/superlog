import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSavedViewSearchParams,
  captureSavedViewState,
  savedViewStateEquals,
} from "./saved-view-state.ts";

test("captures a relative logs view from Explore state", () => {
  const state = captureSavedViewState({
    source: "logs",
    selection: { seconds: 900, label: "Last 15 minutes" },
    absoluteRange: null,
    attrs: [
      { key: "service.name", value: "checkout" },
      { key: "deployment.environment", value: "production" },
    ],
    severity: "ERROR",
    statusCode: "STATUS_CODE_ERROR",
    groupBy: "service.name",
    tracesView: "spans",
  });

  assert.deepEqual(state, {
    source: "logs",
    range: { type: "relative", seconds: 900, label: "Last 15 minutes" },
    attrs: [
      { key: "service.name", value: "checkout" },
      { key: "deployment.environment", value: "production" },
    ],
    severity: "ERROR",
    groupBy: "service.name",
  });
});

test("captures a pinned absolute traces view", () => {
  const state = captureSavedViewState({
    source: "traces",
    selection: { seconds: 3600, label: "Last hour" },
    absoluteRange: {
      since: "2026-07-15T08:00:00.000Z",
      until: "2026-07-15T09:00:00.000Z",
    },
    attrs: [],
    severity: "ERROR",
    statusCode: "STATUS_CODE_ERROR",
    groupBy: "",
    tracesView: "spans",
  });

  assert.deepEqual(state, {
    source: "traces",
    range: {
      type: "absolute",
      since: "2026-07-15T08:00:00.000Z",
      until: "2026-07-15T09:00:00.000Z",
    },
    attrs: [],
    statusCode: "STATUS_CODE_ERROR",
    tracesView: "spans",
  });
});

test("builds a clean shareable query for a saved view", () => {
  const params = buildSavedViewSearchParams(
    {
      source: "traces",
      range: { type: "relative", seconds: 300, label: "Last 5 minutes" },
      attrs: [{ key: "service.name", value: "api" }],
      statusCode: "STATUS_CODE_ERROR",
      groupBy: "service.name",
      tracesView: "spans",
    },
    "view-123",
  );

  assert.equal(
    params.toString(),
    "savedView=view-123&range=300&rangeLabel=Last+5+minutes&attr=service.name%3Dapi&status=STATUS_CODE_ERROR&group=service.name&view=spans",
  );
});

test("compares equivalent filter sets without depending on attribute order", () => {
  const left = {
    source: "logs" as const,
    range: { type: "relative" as const, seconds: 3600, label: "Last hour" },
    attrs: [
      { key: "service.name", value: "api" },
      { key: "cloud.region", value: "us-west-2" },
    ],
    severity: "ERROR",
  };
  const right = {
    ...left,
    attrs: [...left.attrs].reverse(),
  };

  assert.equal(savedViewStateEquals(left, right), true);
  assert.equal(savedViewStateEquals(left, { ...right, severity: "WARN" }), false);
});

test("compares equivalent states without depending on JSON object key order", () => {
  const captured = {
    source: "logs" as const,
    range: { type: "relative" as const, seconds: 3600, label: "Last 1h" },
    attrs: [],
    severity: "ERROR",
  };
  const fromJsonb = JSON.parse(
    '{"attrs":[],"range":{"label":"Last 1h","seconds":3600,"type":"relative"},"source":"logs","severity":"ERROR"}',
  );

  assert.equal(savedViewStateEquals(captured, fromJsonb), true);
});
