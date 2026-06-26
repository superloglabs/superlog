/**
 * Regression test: ECONNRESET / "aborted" errors from client disconnects must
 * NOT be recorded as ERROR spans in `ingest.forward`.  They are client-side
 * events (the OTLP exporter closed the TCP connection before we responded) and
 * should be handled gracefully with a warn-level log, not a span error.
 *
 * Incident: ECONNRESET: abortIncoming@node:_http_server
 * (issue 68da3b1e-26e5-4e3d-b38f-89045cb45934)
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Inline copy of the helper so we can test it without importing the whole
// index.ts (which pulls in db / env / OTel init).
// ---------------------------------------------------------------------------
function isClientAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as NodeJS.ErrnoException;
  return e.message === "aborted" || e.code === "ECONNRESET" || e.code === "ECONNABORTED";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("isClientAbortError: detects message=aborted (Node HTTP server throw)", () => {
  const err = new Error("aborted");
  assert.equal(isClientAbortError(err), true);
});

test("isClientAbortError: detects code=ECONNRESET", () => {
  const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(isClientAbortError(err), true);
});

test("isClientAbortError: detects code=ECONNABORTED", () => {
  const err = Object.assign(new Error("connection aborted"), { code: "ECONNABORTED" });
  assert.equal(isClientAbortError(err), true);
});

test("isClientAbortError: does NOT match generic server errors", () => {
  assert.equal(isClientAbortError(new Error("ETIMEDOUT")), false);
  assert.equal(isClientAbortError(new Error("upstream returned 500")), false);
  assert.equal(isClientAbortError(new TypeError("fetch failed")), false);
  assert.equal(isClientAbortError(null), false);
  assert.equal(isClientAbortError("string error"), false);
});

// ---------------------------------------------------------------------------
// Simulate the span-recording logic from forward()'s catch block.
// Before the fix: span always got recordException + setStatus(ERROR).
// After the fix:  client-abort errors skip that path → span stays clean.
// ---------------------------------------------------------------------------
test("forward catch block: client abort does not record ERROR on span", () => {
  const events: string[] = [];
  const mockSpan = {
    recordException: (_err: unknown) => events.push("recordException"),
    setStatus: (s: { code: number }) => events.push(`setStatus(${s.code})`),
    setAttribute: (_k: string, _v: unknown) => {},
    end: () => {},
  };

  const SpanStatusCode = { ERROR: 2 };

  // Reproduce the patched catch block logic:
  function handleCatch(err: unknown, span: typeof mockSpan) {
    if (isClientAbortError(err)) {
      span.setAttribute("ingest.client_aborted", true);
      // warn log (omitted in test), return 499
      return 499;
    }
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  }

  // Client abort: span must stay clean
  const clientErr = new Error("aborted");
  const status = handleCatch(clientErr, mockSpan);
  assert.equal(status, 499);
  assert.equal(events.length, 0, "no recordException or setStatus for client aborts");

  // Real server error: span must be tagged ERROR
  const serverErr = new Error("upstream timeout");
  assert.throws(() => handleCatch(serverErr, mockSpan));
  assert.deepEqual(events, ["recordException", "setStatus(2)"]);
});
