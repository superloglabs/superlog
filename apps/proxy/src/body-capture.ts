/**
 * Bounded, streaming capture of a request body.
 *
 * The proxy must never hold an unbounded amount of memory per request. This
 * reads the body incrementally and:
 *
 *   - rejects anything larger than `maxBytes` (the hard accept/reject cut — the
 *     caller maps this to a 413), enforced as bytes arrive so it aborts at the
 *     cap instead of after buffering, and WITHOUT trusting Content-Length;
 *   - keeps small bodies (<= `inlineThresholdBytes`) in memory so the caller can
 *     take a fast inline path;
 *   - for anything larger, opens a {@link SpillSink} (e.g. a streaming S3 upload)
 *     and streams the body through it, so the bytes held in memory at any moment
 *     stay bounded by the spill sink's internal buffering, not the body size.
 *
 * The sink is injected so this stays edition-neutral and unit-testable: the
 * cloud queue path provides an S3-backed sink; a sink could equally stream to
 * the collector. Capture never references S3 directly.
 */

export interface SpillSink {
  /** Write a chunk. Should resolve only once the chunk is accepted (honoring
   *  the sink's own backpressure), so a slow sink throttles the source read. */
  write(chunk: Uint8Array): Promise<void>;
  /** Finalize the upload/forward. Called once, after the last chunk. */
  finish(): Promise<void>;
  /** Tear down a partial upload/forward on error. Must be idempotent-safe. */
  abort(): Promise<void>;
}

export type CaptureResult =
  | { storage: "buffer"; buffer: Buffer; totalBytes: number }
  | { storage: "spilled"; totalBytes: number };

export interface CaptureOptions {
  /** Bodies at or below this many raw bytes are returned buffered in memory. */
  inlineThresholdBytes: number;
  /** Hard ceiling. A body exceeding this is rejected with PayloadTooLargeError. */
  maxBytes: number;
  /** Factory for the spill sink, invoked lazily only when a body spills. */
  createSpillSink: () => SpillSink;
}

export class PayloadTooLargeError extends Error {
  constructor(
    readonly limitBytes: number,
    readonly observedBytes: number,
  ) {
    super(`ingest body exceeds the ${limitBytes}-byte limit`);
    this.name = "PayloadTooLargeError";
  }
}

export class EmptyBodyError extends Error {
  constructor() {
    super("ingest body is empty; no records to forward");
    this.name = "EmptyBodyError";
  }
}

export async function captureBody(
  source: AsyncIterable<Uint8Array>,
  opts: CaptureOptions,
): Promise<CaptureResult> {
  const { inlineThresholdBytes, maxBytes, createSpillSink } = opts;

  const buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let totalBytes = 0;
  let sink: SpillSink | null = null;

  try {
    for await (const raw of source) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (chunk.length === 0) continue;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        throw new PayloadTooLargeError(maxBytes, totalBytes);
      }

      const fitsInBuffer = sink === null && bufferedBytes + chunk.length <= inlineThresholdBytes;
      if (fitsInBuffer) {
        buffered.push(chunk);
        bufferedBytes += chunk.length;
        continue;
      }

      if (sink === null) {
        // Crossed the inline threshold: open the sink and flush the prefix we
        // had been holding, in order, before continuing to stream.
        sink = createSpillSink();
        for (const prefix of buffered) {
          await sink.write(prefix);
        }
        buffered.length = 0;
        bufferedBytes = 0;
      }
      await sink.write(chunk);
    }
  } catch (err) {
    if (sink) {
      await sink.abort().catch(() => {});
    }
    throw err;
  }

  if (sink) {
    // Abort on a finish failure too (e.g. S3 CompleteMultipartUpload throwing),
    // otherwise a failed spill leaves a dangling partial upload behind.
    try {
      await sink.finish();
    } catch (err) {
      await sink.abort().catch(() => {});
      throw err;
    }
    return { storage: "spilled", totalBytes };
  }

  if (bufferedBytes === 0) {
    throw new EmptyBodyError();
  }
  return { storage: "buffer", buffer: Buffer.concat(buffered, bufferedBytes), totalBytes };
}
