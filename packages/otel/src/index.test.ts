import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryLogRecordExporter, LoggerProvider } from "@opentelemetry/sdk-logs";
import { createBatchLogRecordProcessor } from "./index.js";

test("exports log records through the configured batch exporter", async () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [createBatchLogRecordProcessor(exporter, { scheduledDelayMillis: 1 })],
  });

  provider.getLogger("bootstrap-test").emit({ body: "worker is alive" });
  await provider.forceFlush();

  assert.deepEqual(
    exporter.getFinishedLogRecords().map((record) => record.body),
    ["worker is alive"],
  );
  await provider.shutdown();
});
