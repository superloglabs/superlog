import { DEFAULT_LOG_PARSE_CONFIG } from "@superlog/db/log-severity";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  previewLogParse,
  sanitizeLogParseConfig,
  sanitizeSourceParseConfig,
} from "./ingest-parsing-service.js";

const base = DEFAULT_LOG_PARSE_CONFIG.aws;

test("sanitize keeps a valid source config and trims/dedupes keys", () => {
  const out = sanitizeSourceParseConfig(
    {
      enabled: true,
      severityKeys: [" level ", "severity", "level", ""],
      severityValueMap: { EMERG: "FATAL", warn: "WARN" },
    },
    base,
  );
  assert.deepEqual(out.severityKeys, ["level", "severity"]);
  assert.deepEqual(out.severityValueMap, { emerg: "FATAL", warn: "WARN" });
  assert.equal(out.enabled, true);
});

test("sanitize drops value-map entries with non-canonical levels", () => {
  const out = sanitizeSourceParseConfig(
    { enabled: true, severityKeys: ["level"], severityValueMap: { foo: "BANANA", ok: "INFO" } },
    base,
  );
  assert.deepEqual(out.severityValueMap, { ok: "INFO" });
});

test("sanitize allows an explicitly empty severityKeys list (user cleared it)", () => {
  const out = sanitizeSourceParseConfig(
    { enabled: true, severityKeys: [], severityValueMap: {} },
    base,
  );
  assert.deepEqual(out.severityKeys, []);
});

test("sanitize falls back when a field is absent or wrong-typed", () => {
  const out = sanitizeSourceParseConfig({ enabled: false } as unknown, base);
  assert.equal(out.enabled, false);
  assert.deepEqual(out.severityKeys, base.severityKeys);
  assert.deepEqual(out.severityValueMap, {});
});

test("sanitize caps the number of keys", () => {
  const many = Array.from({ length: 50 }, (_, i) => `k${i}`);
  const out = sanitizeSourceParseConfig(
    { enabled: true, severityKeys: many, severityValueMap: {} },
    base,
  );
  assert.ok(out.severityKeys.length <= 20);
});

test("sanitizeLogParseConfig sanitizes both sources", () => {
  const out = sanitizeLogParseConfig(
    {
      otlp: { enabled: false, severityKeys: ["lvl"], severityValueMap: {} },
      aws: { enabled: true, severityKeys: ["level"], severityValueMap: { panic: "FATAL" } },
    },
    DEFAULT_LOG_PARSE_CONFIG,
  );
  assert.equal(out.otlp.enabled, false);
  assert.deepEqual(out.otlp.severityKeys, ["lvl"]);
  assert.deepEqual(out.aws.severityValueMap, { panic: "FATAL" });
});

test("previewLogParse returns a detection per sample body", () => {
  const rows = previewLogParse(
    ['{"level":"error","msg":"boom"}', "not json", '{"level":"warning"}'],
    base,
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.detection?.severityNumber, 17);
  assert.equal(rows[0]?.detection?.level, "ERROR");
  assert.equal(rows[1]?.detection, null);
  assert.equal(rows[2]?.detection?.level, "WARN");
  assert.equal(rows[0]?.body, '{"level":"error","msg":"boom"}');
});
