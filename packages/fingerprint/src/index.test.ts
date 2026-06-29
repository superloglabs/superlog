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
