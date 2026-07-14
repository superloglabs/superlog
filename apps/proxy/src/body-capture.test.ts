import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EmptyBodyError,
  PayloadTooLargeError,
  type SpillSink,
  captureBody,
  isExpectedBodyError,
} from "./body-capture.js";

function source(...chunks: Array<Uint8Array | string>): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) {
      yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    }
  })();
}

class FakeSink implements SpillSink {
  written: Buffer[] = [];
  finished = false;
  aborted = false;
  async write(chunk: Uint8Array): Promise<void> {
    this.written.push(Buffer.from(chunk));
  }
  async finish(): Promise<void> {
    this.finished = true;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  get bytes(): number {
    return this.written.reduce((n, b) => n + b.length, 0);
  }
}

test("buffers a small body fully in memory and never opens a spill sink", async () => {
  let created = 0;
  const result = await captureBody(source("hello ", "world"), {
    inlineThresholdBytes: 100,
    maxBytes: 1000,
    createSpillSink: () => {
      created += 1;
      return new FakeSink();
    },
  });

  assert.equal(created, 0);
  assert.equal(result.storage, "buffer");
  assert.equal(result.totalBytes, 11);
  assert.equal(result.buffer?.toString(), "hello world");
});

test("spills to the sink once the body exceeds the inline threshold, flushing the buffered prefix", async () => {
  const sink = new FakeSink();
  const result = await captureBody(source("AAAA", "BBBB", "CCCC"), {
    inlineThresholdBytes: 5, // "AAAA" (4) fits; adding "BBBB" crosses → spill
    maxBytes: 1000,
    createSpillSink: () => sink,
  });

  assert.equal(result.storage, "spilled");
  assert.equal(result.totalBytes, 12);
  // Every byte, including the buffered "AAAA" prefix, reaches the sink in order.
  assert.equal(Buffer.concat(sink.written).toString(), "AAAABBBBCCCC");
  assert.equal(sink.finished, true);
  assert.equal(sink.aborted, false);
});

test("rejects a body over maxBytes with PayloadTooLargeError and aborts the spill", async () => {
  const sink = new FakeSink();
  await assert.rejects(
    captureBody(source("X".repeat(6), "Y".repeat(6)), {
      inlineThresholdBytes: 4, // spills early
      maxBytes: 8,
      createSpillSink: () => sink,
    }),
    (err: unknown) => {
      assert.ok(err instanceof PayloadTooLargeError);
      assert.equal(err.limitBytes, 8);
      return true;
    },
  );
  assert.equal(sink.aborted, true);
  assert.equal(sink.finished, false);
});

test("enforces maxBytes even when still buffering (never spilled)", async () => {
  await assert.rejects(
    captureBody(source("X".repeat(10)), {
      inlineThresholdBytes: 1000, // high → stays in buffer mode
      maxBytes: 5,
      createSpillSink: () => new FakeSink(),
    }),
    PayloadTooLargeError,
  );
});

test("accepts a body exactly at maxBytes", async () => {
  const result = await captureBody(source("X".repeat(8)), {
    inlineThresholdBytes: 1000,
    maxBytes: 8,
    createSpillSink: () => new FakeSink(),
  });
  assert.equal(result.storage, "buffer");
  assert.equal(result.totalBytes, 8);
});

test("aborts the sink when finish() fails, so a failed spill leaves nothing dangling", async () => {
  const sink = new FakeSink();
  const finishError = new Error("CompleteMultipartUpload failed");
  sink.finish = async () => {
    throw finishError;
  };
  await assert.rejects(
    captureBody(source("AAAA", "BBBB", "CCCC"), {
      inlineThresholdBytes: 5, // forces a spill
      maxBytes: 1000,
      createSpillSink: () => sink,
    }),
    (err: unknown) => err === finishError,
  );
  assert.equal(sink.aborted, true);
});

test("treats a zero-byte body as an EmptyBodyError", async () => {
  await assert.rejects(
    captureBody(source(), {
      inlineThresholdBytes: 100,
      maxBytes: 1000,
      createSpillSink: () => new FakeSink(),
    }),
    EmptyBodyError,
  );
});

test("isExpectedBodyError matches only the handled 4xx rejections", () => {
  // These two are mapped to 413/400 by handleIngestBodyError — the request
  // lifecycle handles them, so spans must not be marked ERROR for them
  // (ERROR status on an expected rejection creates false-positive incidents).
  assert.equal(isExpectedBodyError(new PayloadTooLargeError(64, 65)), true);
  assert.equal(isExpectedBodyError(new EmptyBodyError()), true);
  assert.equal(isExpectedBodyError(new Error("boom")), false);
  assert.equal(isExpectedBodyError(undefined), false);
});
