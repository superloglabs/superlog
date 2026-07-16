import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  type RenderSyslogRecord,
  SyslogFrameSplitter,
  createRenderSyslogServer,
  extractIngestKey,
  parseRfc5424,
  renderSyslogToOtlp,
} from "./render-syslog.js";

// Realistic length: real keys are the prefix + 43 chars of base64url.
const KEY = "sl_public_abc123XYZ-_deFGhij456KLmn789opQRst01uv2";
const FRAME = `<14>1 2026-07-08T12:00:00.123456Z srv-abc123 my-api 12 - [render@0 token="${KEY}"] GET /health 200`;

function octet(frame: string): Buffer {
  const bytes = Buffer.from(frame, "utf8");
  return Buffer.concat([Buffer.from(`${bytes.length} `), bytes]);
}

test("splitter handles octet-counted frames across chunk boundaries", () => {
  const splitter = new SyslogFrameSplitter();
  const wire = Buffer.concat([octet(FRAME), octet(FRAME)]);
  const first = splitter.push(wire.subarray(0, 20));
  const rest = splitter.push(wire.subarray(20));
  assert.deepEqual([...first, ...rest], [FRAME, FRAME]);
});

test("splitter handles newline framing and skips blank lines", () => {
  const splitter = new SyslogFrameSplitter();
  const frames = splitter.push(Buffer.from(`${FRAME}\r\n\n${FRAME}\n`));
  assert.deepEqual(frames, [FRAME, FRAME]);
});

test("splitter rejects oversized frame declarations", () => {
  const splitter = new SyslogFrameSplitter();
  assert.throws(() => splitter.push(Buffer.from("99999999 x")));
});

test("extractIngestKey finds current and legacy key formats anywhere in the frame", () => {
  assert.equal(extractIngestKey(FRAME), KEY);
  assert.equal(
    extractIngestKey("<14>1 - - - - - - superlog_live_old123456789abcdef hello"),
    "superlog_live_old123456789abcdef",
  );
  assert.equal(extractIngestKey("<14>1 - - - - - - no token here"), null);
});

test("parseRfc5424 extracts fields, severity, and structured data", () => {
  const record = parseRfc5424(FRAME);
  assert.ok(record);
  assert.equal(record.severityText, "INFO"); // PRI 14 = facility 1, severity 6
  assert.equal(record.severityNumber, 9);
  assert.equal(record.timeUnixNano, "1783512000123456000");
  assert.equal(record.hostname, "srv-abc123");
  assert.equal(record.appName, "my-api");
  assert.equal(record.procId, "12");
  assert.equal(record.msgId, null);
  assert.deepEqual(record.structuredData, { "render@0": { token: KEY } });
  assert.equal(record.message, "GET /health 200");
});

test("parseRfc5424 maps error severities and tolerates nil structured data", () => {
  const record = parseRfc5424("<11>1 2026-07-08T12:00:00Z host app - - - boom");
  assert.ok(record);
  assert.equal(record.severityText, "ERROR"); // PRI 11 = severity 3
  assert.equal(record.structuredData && Object.keys(record.structuredData).length, 0);
  assert.equal(record.message, "boom");
  assert.equal(parseRfc5424("not syslog at all"), null);
});

test("renderSyslogToOtlp groups by app name and never emits the ingest key", () => {
  const a = parseRfc5424(FRAME) as RenderSyslogRecord;
  const b = parseRfc5424(
    `<11>1 2026-07-08T12:00:01Z srv-abc123 other-svc - - - failed: ${KEY}`,
  ) as RenderSyslogRecord;
  const otlp = renderSyslogToOtlp([a, b]) as {
    resourceLogs: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
      scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string } }> }>;
    }>;
  };
  assert.equal(otlp.resourceLogs.length, 2);
  const services = otlp.resourceLogs.map(
    (rl) => rl.resource.attributes.find((attr) => attr.key === "service.name")?.value.stringValue,
  );
  assert.deepEqual(services.sort(), ["my-api", "other-svc"]);
  const serialized = JSON.stringify(otlp);
  assert.ok(!serialized.includes(KEY), "ingest key must be scrubbed");
  assert.ok(serialized.includes("[redacted]"));
  assert.ok(serialized.includes("telemetry.source"));
});

test("parseRfc5424 stays linear on pathological structured-data input", () => {
  // The naive nested-quantifier regex for the SD section backtracks
  // exponentially on this shape (CodeQL js/redos); the linear scanner must
  // return quickly.
  const evil = `<14>1 2026-07-08T12:00:00Z host app - - ${"][".repeat(20_000)} boom`;
  const started = Date.now();
  const record = parseRfc5424(evil);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(record, null);
});

test("parseRfc5424 handles escaped quotes and brackets in param values", () => {
  const record = parseRfc5424(
    '<14>1 2026-07-08T12:00:00Z host app - - [x@1 a="q\\"b" b="c\\]d"] msg',
  );
  assert.ok(record);
  assert.deepEqual(record.structuredData, { "x@1": { a: 'q"b', b: "c]d" } });
});

test("keys are scrubbed from app names and structured-data names, not just values", () => {
  const record = parseRfc5424(
    `<14>1 2026-07-08T12:00:00Z ${KEY} ${KEY} - - [${KEY} note="ok"] hello`,
  ) as RenderSyslogRecord;
  const serialized = JSON.stringify(renderSyslogToOtlp([record]));
  assert.ok(!serialized.includes(KEY), "key must not survive in any OTLP position");
});

test("extractIngestKey bounds the token length so junk can't bloat the auth cache", () => {
  const giant = `sl_public_${"a".repeat(5000)}`;
  const found = extractIngestKey(`<14>1 - - - - - - ${giant}`);
  assert.ok(found);
  assert.ok(found.length <= 101);
});

// --- server integration over a real socket -----------------------------------------

type Delivered = { projectId: string; records: RenderSyslogRecord[] };

async function withServer(
  authenticate: (key: string) => Promise<string | null>,
  run: (port: number, delivered: Delivered[]) => Promise<void>,
): Promise<void> {
  const delivered: Delivered[] = [];
  const server = createRenderSyslogServer({
    authenticate,
    deliver: async (projectId, records) => {
      delivered.push({ projectId, records });
    },
    log: { info: () => {}, warn: () => {} },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  try {
    await run(address.port, delivered);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function send(port: number, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end(payload, () => resolve());
    });
    socket.on("error", reject);
  });
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), "condition not met in time");
}

test("server authenticates by embedded token and delivers parsed records", async () => {
  await withServer(
    async (key) => (key === KEY ? "project-1" : null),
    async (port, delivered) => {
      await send(port, octet(FRAME));
      await eventually(() => delivered.length === 1);
      assert.equal(delivered[0]?.projectId, "project-1");
      assert.equal(delivered[0]?.records[0]?.appName, "my-api");
    },
  );
});

test("token-less frames inherit the connection's authenticated project", async () => {
  const tokenless = "<14>1 2026-07-08T12:00:02Z srv-abc123 my-api - - - plain line";
  await withServer(
    async (key) => (key === KEY ? "project-1" : null),
    async (port, delivered) => {
      await send(port, Buffer.concat([octet(FRAME), octet(tokenless)]));
      await eventually(() => delivered.flatMap((d) => d.records).length === 2);
      for (const batch of delivered) assert.equal(batch.projectId, "project-1");
    },
  );
});

test("frames that never authenticate are dropped, not delivered", async () => {
  const calls: string[] = [];
  await withServer(
    async (key) => {
      calls.push(key);
      return null;
    },
    async (port, delivered) => {
      await send(port, octet(FRAME));
      await eventually(() => calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(delivered.length, 0);
    },
  );
});

test("a missing key is rechecked on a following frame", async () => {
  let calls = 0;
  await withServer(
    async () => {
      calls += 1;
      return calls === 1 ? null : "project-1";
    },
    async (port, delivered) => {
      await send(port, octet(FRAME));
      await eventually(() => calls === 1);
      assert.equal(delivered.length, 0);

      await send(port, octet(FRAME));
      await eventually(() => delivered.length === 1);
      assert.equal(calls, 2);
      assert.equal(delivered[0]?.projectId, "project-1");
    },
  );
});
