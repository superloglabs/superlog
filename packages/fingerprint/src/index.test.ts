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

// Serverless platforms stamp every runtime log line with a per-request ID
// whose tail is a short (8-16 char) hex run plus a mixed letter-digit node
// token, e.g. `sin1::h4p45-1783721553799-7973d118dc17`. The old rules only
// collapsed hex runs of 20+ chars, so every request produced a unique
// fingerprint — one flooding deployment can mint tens of thousands of issues.
test("fingerprintLog groups request-scoped runtime log lines from serverless drains", () => {
  const line = (region: string, node: string, epoch: string, hexTail: string, path: string) =>
    `START RequestId: ${region}::${node}-${epoch}-${hexTail}\n[GET] ${path}`;
  const base = {
    service: "storefront",
    severity: "ERROR",
    exceptionType: "ERROR",
    stacktrace: null,
  };
  const fp1 = fingerprintLog({
    ...base,
    body: line("sin1", "h4p45", "1783721553799", "7973d118dc17", "/collections/bath?filter=a"),
  });
  // Node tokens with a single digit run (sv2np) and other regions must group
  // too: the whole digit-bearing `scope::token` blob collapses to one id.
  const fp2 = fingerprintLog({
    ...base,
    body: line("gru1", "sv2np", "1783721551971", "8ab18e6846a0", "/collections/kids?filter=b"),
  });
  assert.equal(fp1.hash, fp2.hash);
});

test("digit-free scoped tokens like C++ symbols survive normalization", () => {
  const a = fingerprintLog({
    service: "s",
    severity: "ERROR",
    body: "terminate called after throwing an instance of std::bad_alloc",
    exceptionType: null,
    stacktrace: null,
  });
  const b = fingerprintLog({
    service: "s",
    severity: "ERROR",
    body: "terminate called after throwing an instance of std::length_error",
    exceptionType: null,
    stacktrace: null,
  });
  assert.notEqual(a.hash, b.hash);
});

test("normalized log bodies collapse short hex runs and mixed letter-digit id tokens", () => {
  const a = fingerprintLog({
    service: "s",
    severity: "ERROR",
    body: "cache write failed for entry 7973d118dc17 on node h4p45",
    exceptionType: null,
    stacktrace: null,
  });
  const b = fingerprintLog({
    service: "s",
    severity: "ERROR",
    body: "cache write failed for entry 8ab18e6846a0 on node 2kxk8",
    exceptionType: null,
    stacktrace: null,
  });
  assert.equal(a.hash, b.hash);
});

test("meaningful single-digit-run tokens are not collapsed", () => {
  // utf8 / sha256 / base64-style tokens carry meaning and have one digit run;
  // only tokens with 2+ separate digit runs (id shapes) may collapse.
  const a = fingerprintLog({
    service: "s",
    severity: "ERROR",
    body: "sha256 digest mismatch decoding utf8 payload",
    exceptionType: null,
    stacktrace: null,
  });
  const b = fingerprintLog({
    service: "s",
    severity: "ERROR",
    body: "base64 padding error decoding utf8 payload",
    exceptionType: null,
    stacktrace: null,
  });
  assert.notEqual(a.hash, b.hash);
});

test("messageBucketFor collapses short hex runs and id tokens for span messages", () => {
  assert.equal(
    messageBucketFor("upstream call failed (request 7973d118dc17 via sin1::h4p45)"),
    messageBucketFor("upstream call failed (request 8ab18e6846a0 via gru1::sv2np)"),
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
