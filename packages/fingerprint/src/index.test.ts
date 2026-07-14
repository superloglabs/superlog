import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint, fingerprintLog, messageBucketFor, sanitizeForPg } from "./index.js";

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

// Postgres text/jsonb columns reject two things telemetry can carry: the NUL
// byte (0x00 -> `22021 invalid byte sequence`) and lone UTF-16 surrogates
// (-> `22P05 untranslatable_character`). The fingerprint outputs feed straight
// into the issues upsert, so they must be free of both.
const NUL = String.fromCharCode(0);
const LONE_HIGH = String.fromCharCode(0xd800); // unpaired high surrogate
const LONE_LOW = String.fromCharCode(0xdc00); // unpaired low surrogate
const EMOJI = "\u{1f4a5}"; // a valid surrogate pair — must survive intact
const REPLACEMENT = "�";

test("sanitizeForPg removes NUL bytes and leaves other text intact", () => {
  assert.equal(sanitizeForPg(`ab${NUL}cd`), "abcd");
  assert.equal(sanitizeForPg(`${NUL}boom${NUL}`), "boom");
  assert.equal(sanitizeForPg("clean string"), "clean string");
  assert.equal(sanitizeForPg(null), null);
  assert.equal(sanitizeForPg(undefined), undefined);
});

test("sanitizeForPg replaces lone surrogates but keeps valid pairs", () => {
  assert.equal(sanitizeForPg(`a${LONE_HIGH}b`), `a${REPLACEMENT}b`);
  assert.equal(sanitizeForPg(`a${LONE_LOW}b`), `a${REPLACEMENT}b`);
  // A truncated pair (high without its low) is still a lone surrogate.
  assert.equal(sanitizeForPg(`x${LONE_HIGH}`), `x${REPLACEMENT}`);
  // A valid emoji (proper high+low pair) must pass through unchanged.
  assert.equal(sanitizeForPg(`hi ${EMOJI}`), `hi ${EMOJI}`);
});

test("fingerprint sanitizes exception type and frames for Postgres", () => {
  const fp = fingerprint({
    type: `Boom${NUL}${LONE_HIGH}Error`,
    stacktrace: `    at do${NUL}Thing (apps/worker/src/x.ts:1:1)`,
    message: "broke here",
  });
  const bad = (s: string) => s.includes(NUL) || s.includes(LONE_HIGH) || s.includes(LONE_LOW);
  assert.equal(bad(fp.exceptionType), false);
  assert.ok(!(fp.topFrame && bad(fp.topFrame)));
  for (const frame of fp.normalizedFrames) {
    assert.equal(bad(frame), false);
  }
});

test("fingerprintLog sanitizes exception type for Postgres", () => {
  const fp = fingerprintLog({
    service: "superlog-worker",
    severity: "ERROR",
    body: `tick step failed${NUL}`,
    exceptionType: `Cause${LONE_LOW}Error`,
    stacktrace: null,
  });
  assert.equal(fp.exceptionType.includes(NUL), false);
  assert.equal(fp.exceptionType.includes(LONE_LOW), false);
});
