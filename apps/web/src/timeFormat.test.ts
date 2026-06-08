import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalHm, formatLocalTimestamp, formatLocalTimestampMs } from "./timeFormat.ts";

type TimeFormatModule = typeof import("./timeFormat.ts");

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function localTimestamp(utcIso: string): string {
  const date = new Date(utcIso);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

function localHm(utcIso: string): string {
  const date = new Date(utcIso);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

async function freshModule(name: string): Promise<TimeFormatModule> {
  // Append a unique query string so Node's ESM loader treats each import as a new module URL, bypassing the module cache.
  const url = new URL("./timeFormat.ts", import.meta.url);
  url.searchParams.set("test", name);
  return (await import(url.href)) as TimeFormatModule;
}

async function withMockDateTimeFormat<T>(
  mock: typeof Intl.DateTimeFormat,
  run: () => T | Promise<T>,
): Promise<T> {
  const original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = mock;
  try {
    return await run();
  } finally {
    Intl.DateTimeFormat = original;
  }
}

test("formatLocalTimestamp treats ClickHouse timestamp strings as UTC", () => {
  assert.equal(formatLocalTimestamp("2026-06-08 00:05:09"), localTimestamp("2026-06-08T00:05:09Z"));
});

test("formatLocalTimestamp accepts ISO separators and strips fractional seconds", () => {
  assert.equal(
    formatLocalTimestamp("2026-06-08T00:05:09.987654"),
    localTimestamp("2026-06-08T00:05:09Z"),
  );
});

test("formatLocalTimestamp returns unparseable input unchanged", () => {
  assert.equal(formatLocalTimestamp("not a timestamp"), "not a timestamp");
  assert.equal(formatLocalTimestamp(""), "");
});

test("formatLocalTimestampMs appends hundredths for whole-second timestamps", () => {
  assert.equal(
    formatLocalTimestampMs("2026-06-08 00:05:09"),
    `${localTimestamp("2026-06-08T00:05:09Z")}.00`,
  );
});

test("formatLocalTimestampMs rounds fractional seconds to two digits", () => {
  assert.equal(
    formatLocalTimestampMs("2026-06-08 00:05:09.124"),
    `${localTimestamp("2026-06-08T00:05:09Z")}.12`,
  );
  assert.equal(
    formatLocalTimestampMs("2026-06-08 00:05:09.125"),
    `${localTimestamp("2026-06-08T00:05:09Z")}.13`,
  );
  assert.equal(
    formatLocalTimestampMs("2026-06-08 00:05:09.999"),
    `${localTimestamp("2026-06-08T00:05:10Z")}.00`,
  );
});

test("formatLocalTimestampMs defaults malformed fractions to zero hundredths", () => {
  assert.equal(
    formatLocalTimestampMs("2026-06-08 00:05:09.nope"),
    `${localTimestamp("2026-06-08T00:05:09Z")}.00`,
  );
});

test("formatLocalTimestampMs returns unparseable input unchanged", () => {
  assert.equal(formatLocalTimestampMs("not a timestamp"), "not a timestamp");
  assert.equal(formatLocalTimestampMs(""), "");
});

test("formatLocalHm emits local hour and minute for valid UTC timestamps", () => {
  assert.equal(formatLocalHm("2026-06-08 00:05:09"), localHm("2026-06-08T00:05:09Z"));
  assert.equal(formatLocalHm("2026-06-08T23:59:59"), localHm("2026-06-08T23:59:59Z"));
});

test("formatLocalHm falls back to the original string or its time slice", () => {
  assert.equal(formatLocalHm("bad"), "bad");
  assert.equal(formatLocalHm("2026-06-08 xx:yy"), "xx:yy");
});

test("localTzAbbr reads and caches the short timezone name", async () => {
  const mod = await freshModule("cache");
  let calls = 0;
  let zoneName = "TST";

  function MockDateTimeFormat() {
    calls += 1;
    return {
      formatToParts: () => [{ type: "timeZoneName", value: zoneName }],
      resolvedOptions: () => ({ timeZone: "Etc/Unused" }),
    };
  }

  await withMockDateTimeFormat(MockDateTimeFormat as unknown as typeof Intl.DateTimeFormat, () => {
    assert.equal(mod.localTzAbbr(), "TST");
    zoneName = "NEXT";
    assert.equal(mod.localTzAbbr(), "TST");
    assert.equal(calls, 1);
  });
});

test("localTzAbbr falls back to the resolved timezone when no short name is available", async () => {
  const mod = await freshModule("resolved-timezone");

  function MockDateTimeFormat() {
    return {
      formatToParts: () => [{ type: "literal", value: "" }],
      resolvedOptions: () => ({ timeZone: "Etc/Fixture" }),
    };
  }

  await withMockDateTimeFormat(MockDateTimeFormat as unknown as typeof Intl.DateTimeFormat, () => {
    assert.equal(mod.localTzAbbr(), "Etc/Fixture");
  });
});

test("localTzAbbr falls back to local when Intl formatting throws", async () => {
  const mod = await freshModule("throws");

  function MockDateTimeFormat() {
    throw new Error("Intl unavailable");
  }

  await withMockDateTimeFormat(MockDateTimeFormat as unknown as typeof Intl.DateTimeFormat, () => {
    assert.equal(mod.localTzAbbr(), "local");
  });
});
