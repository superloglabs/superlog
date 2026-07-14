import assert from "node:assert/strict";
import test from "node:test";
import type { IngestFilterState } from "./api.ts";
import { updateIngestSignal } from "./settings/ingestFiltersModel.ts";

const filters: IngestFilterState = {
  otlp: { traces: true, logs: true, metrics: true },
  aws: { logs: true, metrics: true },
  vercel: { traces: true, logs: true },
  railway: { logs: true, metrics: true },
  render: { logs: true, metrics: true },
};

test("changing one ingest signal preserves every other source and the original state", () => {
  const updated = updateIngestSignal(filters, "aws", "logs", false);

  assert.equal(updated.aws.logs, false);
  assert.equal(updated.aws.metrics, true);
  assert.equal(updated.otlp, filters.otlp);
  assert.equal(updated.vercel, filters.vercel);
  assert.equal(filters.aws.logs, true);
  assert.notEqual(updated.aws, filters.aws);
});
