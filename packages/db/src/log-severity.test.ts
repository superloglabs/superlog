import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LOG_PARSE_CONFIG,
  DEFAULT_SEVERITY_KEYS,
  detectLogSeverity,
  resolveSourceParseConfig,
  SEVERITY_NUMBER_BY_LEVEL,
  type SourceParseConfig,
} from "./log-severity.js";

const cfg = (over: Partial<SourceParseConfig> = {}): SourceParseConfig => ({
  enabled: true,
  severityKeys: ["level", "severity"],
  severityValueMap: {},
  ...over,
});

test("returns null when parsing is disabled", () => {
  assert.equal(detectLogSeverity('{"level":"error"}', cfg({ enabled: false })), null);
});

test("parses a canonical level from a JSON-string body", () => {
  const d = detectLogSeverity('{"level":"error"}', cfg());
  assert.equal(d?.level, "ERROR");
  assert.equal(d?.severityNumber, 17);
  assert.equal(d?.severityText, "ERROR");
  assert.equal(d?.matchedKey, "level");
  assert.equal(d?.matchedValue, "error");
});

test("works on an already-parsed object body", () => {
  const d = detectLogSeverity({ level: "info" }, cfg());
  assert.equal(d?.level, "INFO");
  assert.equal(d?.severityNumber, 9);
});

test("checks severityKeys in order; earlier key wins", () => {
  const d = detectLogSeverity({ level: "warn", severity: "error" }, cfg());
  assert.equal(d?.level, "WARN");
  assert.equal(d?.matchedKey, "level");
});

test("falls through to a later key when an earlier one is absent", () => {
  const d = detectLogSeverity({ severity: "debug" }, cfg());
  assert.equal(d?.level, "DEBUG");
  assert.equal(d?.matchedKey, "severity");
});

test("skips a present-but-unmappable key and uses the next mappable one", () => {
  const d = detectLogSeverity({ level: "purple", severity: "error" }, cfg());
  assert.equal(d?.level, "ERROR");
  assert.equal(d?.matchedKey, "severity");
});

test("maps common synonyms deterministically", () => {
  assert.equal(detectLogSeverity({ level: "warning" }, cfg())?.level, "WARN");
  assert.equal(detectLogSeverity({ level: "err" }, cfg())?.level, "ERROR");
  assert.equal(detectLogSeverity({ level: "critical" }, cfg())?.level, "FATAL");
  assert.equal(detectLogSeverity({ level: "emerg" }, cfg())?.level, "FATAL");
  assert.equal(detectLogSeverity({ level: "notice" }, cfg())?.level, "INFO");
});

test("is case-insensitive on the raw value and the key", () => {
  assert.equal(detectLogSeverity({ LEVEL: "ErRoR" }, cfg())?.level, "ERROR");
});

test("applies a custom severityValueMap before built-ins", () => {
  const d = detectLogSeverity(
    { level: "emerg" },
    cfg({ severityValueMap: { emerg: "ERROR" } }),
  );
  // custom map overrides the built-in emerg->FATAL
  assert.equal(d?.level, "ERROR");
});

test("custom value map handles numeric levels (e.g. pino)", () => {
  const d = detectLogSeverity(
    { level: 50 },
    cfg({ severityKeys: ["level"], severityValueMap: { "50": "ERROR", "60": "FATAL" } }),
  );
  assert.equal(d?.level, "ERROR");
  assert.equal(d?.matchedValue, "50");
});

test("resolves dotted keys against nested objects", () => {
  const d = detectLogSeverity(
    { log: { level: "debug" } },
    cfg({ severityKeys: ["log.level"] }),
  );
  assert.equal(d?.level, "DEBUG");
  assert.equal(d?.matchedKey, "log.level");
});

test("resolves a flattened dotted key too", () => {
  const d = detectLogSeverity({ "log.level": "warn" }, cfg({ severityKeys: ["log.level"] }));
  assert.equal(d?.level, "WARN");
});

test("returns null for a non-JSON / unstructured body", () => {
  assert.equal(detectLogSeverity("plain text line, no json", cfg()), null);
  assert.equal(detectLogSeverity("", cfg()), null);
  assert.equal(detectLogSeverity(42, cfg()), null);
});

test("returns null when no configured key is present", () => {
  assert.equal(detectLogSeverity({ msg: "hi" }, cfg()), null);
});

test("never guesses: an unknown value with no mapping yields null", () => {
  assert.equal(detectLogSeverity({ level: "spicy" }, cfg()), null);
});

test("default config carries sensible keys and is enabled per source", () => {
  assert.deepEqual(DEFAULT_LOG_PARSE_CONFIG.aws.severityKeys, DEFAULT_SEVERITY_KEYS);
  assert.equal(DEFAULT_LOG_PARSE_CONFIG.aws.enabled, true);
  assert.equal(DEFAULT_LOG_PARSE_CONFIG.otlp.enabled, true);
});

test("SEVERITY_NUMBER_BY_LEVEL uses the base of each OTLP band", () => {
  assert.deepEqual(SEVERITY_NUMBER_BY_LEVEL, {
    TRACE: 1,
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
    FATAL: 21,
  });
});

test("resolveSourceParseConfig fills missing fields from defaults", () => {
  const resolved = resolveSourceParseConfig(undefined, "aws");
  assert.deepEqual(resolved.severityKeys, DEFAULT_SEVERITY_KEYS);
  assert.equal(resolved.enabled, true);

  const partial = resolveSourceParseConfig({ enabled: false } as Partial<SourceParseConfig>, "otlp");
  assert.equal(partial.enabled, false);
  assert.deepEqual(partial.severityKeys, DEFAULT_SEVERITY_KEYS);
  assert.deepEqual(partial.severityValueMap, {});
});
