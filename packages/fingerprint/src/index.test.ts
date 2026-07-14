import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint, fingerprintLog, messageBucketFor, stripNullBytes } from "./index.js";

// A single route-scanner error class (e.g. Phoenix NoRouteError) emits one
// exception per probed path. The stacktrace is identical across all of them —
// only the request path in the message differs — so without path normalization
// every probed URL becomes its own issue. One bot sweep then explodes into tens
// of thousands of distinct fingerprints, which floods issue ingestion. Collapse
// request paths so the whole sweep groups into a single issue.
test("messageBucketFor collapses request paths so route-scanner errors group", () => {
  const a = messageBucketFor("no route found for GET /wp-admin/install.php (AppWeb.Router)");
  const b = messageBucketFor("no route found for GET /.git/config (AppWeb.Router)");
  const c = messageBucketFor("no route found for GET /apple-touch-icon.png (AppWeb.Router)");
  assert.equal(a, b);
  assert.equal(b, c);
  assert.match(a, /<path>/);
});

test("fingerprint groups same-stack route-scanner errors that differ only by path", () => {
  const stack = "    at AppWeb.Router.call (lib/app_web/router.ex:1:1)";
  const fp1 = fingerprint({
    type: "Elixir.Phoenix.Router.NoRouteError",
    stacktrace: stack,
    message: "no route found for GET /wp-admin/install.php (AppWeb.Router)",
  });
  const fp2 = fingerprint({
    type: "Elixir.Phoenix.Router.NoRouteError",
    stacktrace: stack,
    message: "no route found for GET /.env (AppWeb.Router)",
  });
  assert.equal(fp1.hash, fp2.hash);
});

test("messageBucketFor keeps a bare path token distinct from a real path", () => {
  // A leading-slash path collapses; an in-word slash (and/or) must not.
  assert.equal(messageBucketFor("request to /api/v2/users failed"), "request to <path> failed");
  assert.equal(
    messageBucketFor("read timeout and/or connection reset"),
    "read timeout and/or connection reset",
  );
});

test("messageBucketFor still separates genuinely different messages", () => {
  assert.notEqual(
    messageBucketFor("model is not supported"),
    messageBucketFor("extra inputs are not permitted"),
  );
});

const VERCEL_LOG = {
  service: "storefront",
  severity: "ERROR",
  exceptionType: "ERROR",
  stacktrace: null,
};

function vercelRuntimeEnvelope(input: {
  id: string;
  method?: string;
  path?: string;
  status?: number;
  report?: string;
  startMetadata?: string;
}): string {
  const method = input.method ?? "GET";
  const path = input.path ?? "/collections/summer";
  const status = input.status ?? 503;
  const report =
    input.report ??
    "Duration: 25880 ms Billed Duration: 25880 ms Memory Size: 2048 MB Max Memory Used: 673 MB";
  const startMetadata = input.startMetadata ? ` ${input.startMetadata}` : "";
  return [
    `START RequestId: ${input.id}${startMetadata}`,
    `[${method}] ${path} status=${status}`,
    `END RequestId: ${input.id}`,
    `REPORT RequestId: ${input.id} ${report}`,
  ].join("\n");
}

test("fingerprintLog groups equivalent Vercel runtime request envelopes", () => {
  const first = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "sin1::wgjjq-1783721543178-bb29a25d147a",
      path: "/collections/summer?direction=next&filter.p.product_type=Topical",
    }),
  });
  const second = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "gru1::sv2np-1783721551971-8ab18e6846a0",
      path: "/collections/kids?filter.p.product_type=Shampoo",
      report:
        "Duration: 26703 ms Billed Duration: 26703 ms Memory Size: 2048 MB Max Memory Used: 701 MB",
    }),
  });

  assert.equal(first.hash, second.hash);
});

test("fingerprintLog separates Vercel runtime request envelopes by status", () => {
  const unavailable = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "sin1::wgjjq-1783721543178-bb29a25d147a",
      status: 503,
    }),
  });
  const internalError = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "gru1::sv2np-1783721551971-8ab18e6846a0",
      status: 500,
    }),
  });

  assert.notEqual(unavailable.hash, internalError.hash);
});

test("fingerprintLog accepts scoped and opaque Vercel request IDs", () => {
  const scoped = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({ id: "sin1::wgjjq-1783721543178-bb29a25d147a" }),
  });
  const opaque = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({ id: "3f0f7fc2-c088-4e5f-a829-14d3fd5bf8a1" }).replaceAll(
      "\n",
      "\r\n",
    ),
  });

  assert.equal(scoped.hash, opaque.hash);
});

test("fingerprintLog ignores Vercel START-line runtime version metadata", () => {
  const latest = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "sin1::request-a",
      startMetadata: "Version: $LATEST",
    }),
  });
  const numbered = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "gru1::request-b",
      startMetadata: "Version: 42",
    }),
  });

  assert.equal(latest.hash, numbered.hash);
});

test("fingerprintLog separates Vercel runtime request envelopes by method", () => {
  const get = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({ id: "sin1::request-a", method: "GET" }),
  });
  const post = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({ id: "sin1::request-b", method: "POST" }),
  });

  assert.notEqual(get.hash, post.hash);
});

test("fingerprintLog preserves application output inside a runtime invocation", () => {
  const requestId = "sin1::request-a";
  const withApplicationOutput = (output: string) =>
    [
      `START RequestId: ${requestId}`,
      "[GET] /collections/summer status=503",
      output,
      `END RequestId: ${requestId}`,
      `REPORT RequestId: ${requestId} Duration: 25880 ms`,
    ].join("\n");
  const timeout = fingerprintLog({
    ...VERCEL_LOG,
    body: withApplicationOutput("database connection timed out"),
  });
  const invalidResponse = fingerprintLog({
    ...VERCEL_LOG,
    body: withApplicationOutput("upstream returned invalid JSON"),
  });

  assert.notEqual(timeout.hash, invalidResponse.hash);
});

// Postgres text and jsonb columns reject the NUL byte (0x00) — it raises
// `22021 invalid byte sequence for encoding "UTF8": 0x00`. Telemetry can carry
// a raw NUL in a message or stack frame; the fingerprint outputs feed straight
// into the issues upsert, so they must be NUL-free.
const NUL = String.fromCharCode(0);

test("stripNullBytes removes NUL bytes and leaves other text intact", () => {
  assert.equal(stripNullBytes(`ab${NUL}cd`), "abcd");
  assert.equal(stripNullBytes(`${NUL}boom${NUL}`), "boom");
  assert.equal(stripNullBytes("clean string"), "clean string");
  assert.equal(stripNullBytes(null), null);
  assert.equal(stripNullBytes(undefined), undefined);
});

test("fingerprint strips NUL bytes from exception type and frames", () => {
  const fp = fingerprint({
    type: `Boom${NUL}Error`,
    stacktrace: `    at do${NUL}Thing (apps/worker/src/x.ts:1:1)`,
    message: "broke here",
  });
  assert.equal(fp.exceptionType.includes(NUL), false);
  assert.ok(!fp.topFrame?.includes(NUL));
  for (const frame of fp.normalizedFrames) {
    assert.equal(frame.includes(NUL), false);
  }
});

test("fingerprintLog strips NUL bytes from exception type", () => {
  const fp = fingerprintLog({
    service: "superlog-worker",
    severity: "ERROR",
    body: `tick step failed${NUL}`,
    exceptionType: `Cause${NUL}Error`,
    stacktrace: null,
  });
  assert.equal(fp.exceptionType.includes(NUL), false);
});
