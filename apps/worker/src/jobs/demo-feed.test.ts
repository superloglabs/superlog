import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDemoBatch } from "./demo-feed.js";

type LogRecord = { severityNumber: number };
type Span = { status?: { code?: number }; events?: unknown[] };

function allLogs(batch: ReturnType<typeof buildDemoBatch>): LogRecord[] {
  const rl = (batch.logs as { resourceLogs: { scopeLogs: { logRecords: LogRecord[] }[] }[] })
    .resourceLogs;
  return rl.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords));
}

function allSpans(batch: ReturnType<typeof buildDemoBatch>): Span[] {
  const rs = (batch.traces as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] })
    .resourceSpans;
  return rs.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
}

test("demo feed never emits ERROR logs (would mint competing issues)", () => {
  const logs = allLogs(buildDemoBatch(1_700_000_000_000));
  assert.ok(logs.length > 0);
  // Issues are minted from SeverityNumber >= 17 (ERROR). The feed must stay below.
  for (const l of logs) assert.ok(l.severityNumber < 17, `severity ${l.severityNumber} >= ERROR`);
});

test("demo feed never emits error-status spans or exception events", () => {
  const spans = allSpans(buildDemoBatch(1_700_000_000_000));
  assert.ok(spans.length > 0);
  for (const s of spans) {
    assert.notEqual(s.status?.code, 2, "span status must not be Error (2)");
    assert.ok(!s.events || s.events.length === 0, "span must carry no exception events");
  }
});

test("demo feed stamps timestamps near the provided now (recent data)", () => {
  const now = 1_700_000_000_000;
  const logs = buildDemoBatch(now) as {
    logs: { resourceLogs: { scopeLogs: { logRecords: { timeUnixNano: string }[] }[] }[] };
  };
  const records = logs.logs.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords));
  for (const rec of records) {
    const ms = Number(BigInt(rec.timeUnixNano) / 1_000_000n);
    assert.ok(ms <= now && ms >= now - 120_000, "log timestamp should be within the last ~2m");
  }
});
