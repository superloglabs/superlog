import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  allIngestFilterPairs,
  deriveIngestFilterState,
  disabledPairsFromState,
  ingestFilterKey,
  ingestFilterStateSchema,
} from "./ingest-filters-service.js";

test("allIngestFilterPairs covers every supported source and signal", () => {
  const pairs = allIngestFilterPairs()
    .map((p) => ingestFilterKey(p.source, p.signal))
    .sort();
  assert.deepEqual(pairs, [
    "aws:logs",
    "aws:metrics",
    "gcp:logs",
    "gcp:metrics",
    "otlp:logs",
    "otlp:metrics",
    "otlp:traces",
    "railway:logs",
    "railway:metrics",
    "render:logs",
    "render:metrics",
    "vercel:logs",
    "vercel:traces",
  ]);
});

test("empty disabled set → everything enabled", () => {
  assert.deepEqual(deriveIngestFilterState(new Set()), {
    otlp: { traces: true, logs: true, metrics: true },
    aws: { logs: true, metrics: true },
    gcp: { logs: true, metrics: true },
    vercel: { traces: true, logs: true },
    railway: { logs: true, metrics: true },
    render: { logs: true, metrics: true },
  });
});

test("disabled set flips exactly those pairs off", () => {
  const state = deriveIngestFilterState(new Set(["aws:logs", "otlp:traces", "vercel:logs"]));
  assert.equal(state.aws.logs, false);
  assert.equal(state.otlp.traces, false);
  assert.equal(state.vercel.logs, false);
  assert.equal(state.vercel.traces, true);
  assert.equal(state.aws.metrics, true);
  assert.equal(state.otlp.logs, true);
});

test("disabledPairsFromState is the inverse of derive (round-trip)", () => {
  const disabled = new Set(["aws:logs", "otlp:metrics", "vercel:traces"]);
  const state = deriveIngestFilterState(disabled);
  const back = new Set(
    disabledPairsFromState(state).map((p) => ingestFilterKey(p.source, p.signal)),
  );
  assert.deepEqual(back, disabled);
});

test("state schema rejects unknown source/signal keys", () => {
  assert.equal(
    ingestFilterStateSchema.safeParse({
      otlp: { traces: true, logs: true, metrics: true },
      aws: { logs: true, metrics: true },
      gcp: { logs: true, metrics: true },
      vercel: { traces: true, logs: true },
      railway: { logs: true, metrics: true },
      render: { logs: true, metrics: true },
    }).success,
    true,
  );
  // aws has no "traces"
  assert.equal(
    ingestFilterStateSchema.safeParse({
      otlp: { traces: true, logs: true, metrics: true },
      aws: { logs: true, metrics: true, traces: true },
      gcp: { logs: true, metrics: true },
      vercel: { traces: true, logs: true },
      railway: { logs: true, metrics: true },
      render: { logs: true, metrics: true },
    }).success,
    false,
  );
  // missing a signal
  assert.equal(
    ingestFilterStateSchema.safeParse({
      otlp: { traces: true, logs: true },
      aws: { logs: true, metrics: true },
      gcp: { logs: true, metrics: true },
      vercel: { traces: true, logs: true },
      railway: { logs: true, metrics: true },
      render: { logs: true, metrics: true },
    }).success,
    false,
  );
});

test("state schema defaults GCP filters on for clients built before GCP support", () => {
  const parsed = ingestFilterStateSchema.parse({
    otlp: { traces: true, logs: true, metrics: true },
    aws: { logs: true, metrics: true },
    vercel: { traces: true, logs: true },
    railway: { logs: true, metrics: true },
    render: { logs: true, metrics: true },
  });

  assert.deepEqual(parsed.gcp, { logs: true, metrics: true });
});
