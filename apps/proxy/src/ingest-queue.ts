import { randomUUID } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteMessageBatchCommand,
  type Message,
  ReceiveMessageCommand,
  type ReceiveMessageCommandOutput,
  SQSClient,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { type SpillSink, captureBody } from "./body-capture.js";
import type { IngestRowWriter } from "./clickhouse-writer.js";
import { stampIssueFingerprintsFailOpen } from "./ingest-fingerprints.js";
import { proxyOperationalRecorder } from "./operational-metrics.js";
import { type DecodedRows, decodeOtlpToRows } from "./otlp-decode.js";

const DEFAULT_MAX_MESSAGE_BYTES = 240_000;
// Hard ceiling on a single ingest body. Bodies above this are rejected at the
// edge (413) instead of accepted and buffered/streamed. Set well above the
// largest legitimate payload we have observed (~38 MiB).
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
// Slack reserved for the JSON envelope (field names + metadata) when deciding
// the raw-byte threshold under which a base64 inline message still fits SQS.
const INLINE_ENVELOPE_SLACK_BYTES = 1_024;
// One S3 multipart part held in memory at a time per spilling upload, so a
// large body costs ~PART_SIZE of RSS regardless of its total size.
const SPILL_PART_SIZE_BYTES = 5 * 1024 * 1024;
// Per-origin socket caps for the AWS SDK HTTP clients. @smithy/node-http-handler
// defaults to 50 sockets per origin; under an oversize-payload burst that pool
// can become a hidden bottleneck *tighter* than the upload-lane permit cap, so
// uploads serialize at the socket layer and hold their admission permit longer.
// We size the S3 pool generously (above the upload-lane permit count) so the
// explicit semaphore — not an invisible socket queue — is the single point of
// backpressure. SQS sends are coalesced into batches, so a smaller pool suffices.
const DEFAULT_S3_MAX_SOCKETS = 128;
const DEFAULT_SQS_MAX_SOCKETS = 64;
const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 120;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_CONSUMER_CONCURRENCY = 4;
const MAX_COLLECTOR_ERROR_BODY_CHARS = 1_000;
// SQS hard limits on a single SendMessageBatch/DeleteMessageBatch call: at most
// 10 entries, and (for sends) at most 256 KiB of total payload across entries.
const SQS_BATCH_MAX_ENTRIES = 10;
const SQS_BATCH_MAX_PAYLOAD_BYTES = 256 * 1024;
const SHUTDOWN_RECEIVE_ABORT_SLACK_MS = 5_000;
// How long a pending send may wait for batch-mates before it is flushed anyway.
// Each SQS request is billed individually, so coalescing sends into
// SendMessageBatch cuts the request bill up to 10x; the linger is the latency
// ceiling that coalescing may add to an ingest ack.
const DEFAULT_SEND_LINGER_MS = 50;

type LoggerLike = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type IngestQueueConfig = {
  queueUrl: string;
  region?: string;
  oversizeBucket?: string;
  oversizePrefix: string;
  maxMessageBytes: number;
  maxBodyBytes: number;
  consumerEnabled: boolean;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  batchSize: number;
  consumerConcurrency: number;
  sendLingerMs: number;
  s3MaxSockets: number;
  sqsMaxSockets: number;
};

/**
 * Which admission lane a request belongs in, decided from its declared
 * `Content-Length`. A body at or under the inline threshold buffers in memory
 * and ships inline — cheap and fast (the "buffer" lane). A larger body streams
 * to S3 via a multi-second multipart upload (the "upload" lane). Keeping the two
 * in separate permit pools stops a slow oversize upload from head-of-line
 * blocking a tiny request waiting for the same admission permit.
 *
 * Unknown or invalid sizes (no Content-Length / chunked transfer) default to the
 * buffer lane; `captureBody` still promotes such a body to an S3 spill if it
 * actually crosses the threshold while streaming, so correctness never depends
 * on the header being present — only the lane assignment does.
 */
export function ingestLaneForContentLength(
  declaredContentLengthBytes: number | undefined,
  inlineThresholdBytes: number,
): "buffer" | "upload" {
  if (declaredContentLengthBytes === undefined) return "buffer";
  if (!Number.isFinite(declaredContentLengthBytes) || declaredContentLengthBytes < 0) {
    return "buffer";
  }
  return declaredContentLengthBytes > inlineThresholdBytes ? "upload" : "buffer";
}

export type IngestQueueInput = {
  path: string;
  projectId: string;
  contentType: string;
  contentEncoding?: string;
  body: Buffer;
};

type InlineBody = {
  storage: "inline";
  base64: string;
};

type S3Body = {
  storage: "s3";
  bucket: string;
  key: string;
  sizeBytes: number;
};

type IngestQueueMessage = {
  version: 1;
  kind: "otlp";
  path: string;
  projectId: string;
  contentType: string;
  contentEncoding?: string;
  receivedAt: string;
  body: InlineBody | S3Body;
};

export type CollectorFailureDescription = {
  message: string;
  status: number;
  body?: string;
};

export type EncodedIngestMessage = {
  messageBody: string;
  s3Object?: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
  };
  storage: "inline" | "s3";
};

type QueueDeliveryMetric = {
  path: string;
  projectId: string;
  storage: "inline" | "s3";
  outcome: "delivered" | "collector_error" | "invalid_message" | "delivery_error";
  collectorStatusCode?: number;
  durationMs: number;
  ageMs?: number;
};

export function getIngestQueueConfig(env: NodeJS.ProcessEnv): IngestQueueConfig | null {
  const queueUrl = env.INGEST_QUEUE_URL;
  if (!queueUrl) return null;

  return {
    queueUrl,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
    oversizeBucket: env.INGEST_OVERSIZE_BUCKET || undefined,
    oversizePrefix: env.INGEST_OVERSIZE_PREFIX || "otlp-oversize",
    maxMessageBytes: readPositiveInt(env.INGEST_QUEUE_MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES),
    maxBodyBytes: readPositiveInt(env.INGEST_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    consumerEnabled: env.INGEST_QUEUE_CONSUMER_ENABLED !== "false",
    waitTimeSeconds: readPositiveInt(env.INGEST_QUEUE_WAIT_TIME_SECONDS, DEFAULT_WAIT_TIME_SECONDS),
    visibilityTimeoutSeconds: readPositiveInt(
      env.INGEST_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
    ),
    batchSize: Math.min(readPositiveInt(env.INGEST_QUEUE_BATCH_SIZE, DEFAULT_BATCH_SIZE), 10),
    consumerConcurrency: Math.min(
      readPositiveInt(env.INGEST_QUEUE_CONSUMER_CONCURRENCY, DEFAULT_CONSUMER_CONCURRENCY),
      32,
    ),
    sendLingerMs: readNonNegativeInt(env.INGEST_QUEUE_SEND_LINGER_MS, DEFAULT_SEND_LINGER_MS),
    s3MaxSockets: readPositiveInt(env.INGEST_S3_MAX_SOCKETS, DEFAULT_S3_MAX_SOCKETS),
    sqsMaxSockets: readPositiveInt(env.INGEST_SQS_MAX_SOCKETS, DEFAULT_SQS_MAX_SOCKETS),
  };
}

export function encodeIngestMessage(
  input: IngestQueueInput,
  config: Pick<IngestQueueConfig, "oversizeBucket" | "oversizePrefix" | "maxMessageBytes">,
  now: Date = new Date(),
  id: string = randomUUID(),
): EncodedIngestMessage {
  const baseMessage = {
    version: 1,
    kind: "otlp",
    path: input.path,
    projectId: input.projectId,
    contentType: input.contentType,
    contentEncoding: input.contentEncoding,
    receivedAt: now.toISOString(),
  } satisfies Omit<IngestQueueMessage, "body">;

  const inlineMessage: IngestQueueMessage = {
    ...baseMessage,
    body: {
      storage: "inline",
      base64: input.body.toString("base64"),
    },
  };
  const inlineBody = JSON.stringify(inlineMessage);
  if (Buffer.byteLength(inlineBody) <= config.maxMessageBytes) {
    return { messageBody: inlineBody, storage: "inline" };
  }

  if (!config.oversizeBucket) {
    throw new Error(
      `ingest message is ${Buffer.byteLength(
        inlineBody,
      )} bytes after encoding, exceeding INGEST_QUEUE_MAX_MESSAGE_BYTES=${config.maxMessageBytes}; set INGEST_OVERSIZE_BUCKET to enable S3 offload`,
    );
  }

  const datePrefix = now.toISOString().slice(0, 10).replaceAll("-", "/");
  const key = `${trimSlashes(config.oversizePrefix)}/${datePrefix}/${id}.otlp`;
  const s3Message: IngestQueueMessage = {
    ...baseMessage,
    body: {
      storage: "s3",
      bucket: config.oversizeBucket,
      key,
      sizeBytes: input.body.byteLength,
    },
  };

  return {
    messageBody: JSON.stringify(s3Message),
    storage: "s3",
    s3Object: {
      bucket: config.oversizeBucket,
      key,
      body: input.body,
      contentType: input.contentType,
    },
  };
}

/**
 * A message that can never be delivered no matter how many times it is retried:
 * unparseable JSON, wrong version/kind, or an empty body. These are dropped (deleted)
 * on first receipt instead of cycling through 50 redeliveries to the DLQ — that churn
 * is what pins tens of thousands of empty-body OTLP exports in-flight.
 */
export class PoisonMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoisonMessageError";
  }
}

export function isPoisonMessageError(err: unknown): err is PoisonMessageError {
  return err instanceof PoisonMessageError;
}

export function parseIngestMessage(body: string): IngestQueueMessage {
  let parsed: IngestQueueMessage;
  try {
    parsed = JSON.parse(body) as IngestQueueMessage;
  } catch (err) {
    throw new PoisonMessageError(`ingest queue message is not valid JSON: ${(err as Error).message}`);
  }
  try {
    assertIngestMessage(parsed);
  } catch (err) {
    // A structurally-broken envelope (e.g. wrong field types making assertions throw a
    // TypeError) can never become valid on retry — treat any assertion failure as poison.
    if (err instanceof PoisonMessageError) throw err;
    throw new PoisonMessageError(`ingest queue message is malformed: ${(err as Error).message}`);
  }
  return parsed;
}

/**
 * Whether a collector HTTP status means the payload can never be accepted on retry.
 * A 4xx (other than 408 Request Timeout and 429 Too Many Requests) is a permanent
 * rejection of these exact bytes — e.g. the collector 400s a batch whose
 * http.response_content_length overflows uint64. Re-delivering it just cycles the
 * message through the 900s visibility timeout 50× before the DLQ, pinning
 * ApproximateAgeOfOldestMessage into a sawtooth, so we drop it on first receipt.
 * 408/429 (backpressure/timeout) and 5xx are transient and stay queued for retry.
 */
export function isPermanentCollectorFailure(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

export function describeCollectorFailure(
  status: number,
  responseBody: string,
): CollectorFailureDescription {
  const trimmedBody = responseBody.trim();
  const boundedBody =
    trimmedBody.length > MAX_COLLECTOR_ERROR_BODY_CHARS
      ? `${trimmedBody.slice(0, MAX_COLLECTOR_ERROR_BODY_CHARS)}...`
      : trimmedBody;

  return {
    message: boundedBody ? `collector returned ${status}: ${boundedBody}` : `collector returned ${status}`,
    status,
    ...(boundedBody ? { body: boundedBody } : {}),
  };
}

/** Builds the {@link SpillSink} for a body that exceeds the inline threshold.
 *  Injectable so the streaming/enqueue logic can be tested without S3 (the
 *  default is an S3 multipart upload). */
export type SpillSinkFactory = (params: {
  bucket: string | undefined;
  key: string;
  contentType: string;
}) => SpillSink;

type PendingSend = {
  messageBody: string;
  bytes: number;
  resolve: () => void;
  reject: (err: unknown) => void;
};

/** Outcome of processing one received message: whether the consume loop should
 *  delete it from the queue, and which offloaded S3 body to purge once that
 *  delete has succeeded. */
type ProcessedMessage = {
  message: Message;
  shouldDelete: boolean;
  s3Cleanup?: { bucket: string; key: string };
};

export class IngestQueue {
  private readonly sqs: SQSClient;
  private readonly s3: S3Client;
  // Raw-byte threshold below which a body's base64 inline envelope still fits
  // within maxMessageBytes. Bodies at or under this are buffered in memory and
  // sent inline; larger ones stream to S3. Derived from the SQS message budget.
  // Public so the request edge can route by Content-Length into the matching
  // admission lane (see {@link laneForContentLength}).
  readonly inlineRawThreshold: number;
  private readonly spillSinkFactory: SpillSinkFactory;

  constructor(
    private readonly config: IngestQueueConfig,
    private readonly logger: LoggerLike,
    spillSinkFactory?: SpillSinkFactory,
    private readonly rowWriter?: IngestRowWriter,
  ) {
    const clientConfig = config.region ? { region: config.region } : {};
    // Explicit, generously-sized socket pools so oversize S3 uploads don't queue
    // at the default 50-socket-per-origin layer (which would hold their admission
    // permit longer and starve the buffer lane). The semaphores are the intended
    // backpressure point, not the SDK's hidden socket cap.
    this.sqs = new SQSClient({
      ...clientConfig,
      requestHandler: new NodeHttpHandler({
        httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: config.sqsMaxSockets }),
      }),
    });
    this.s3 = new S3Client({
      ...clientConfig,
      requestHandler: new NodeHttpHandler({
        httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: config.s3MaxSockets }),
      }),
    });
    this.inlineRawThreshold = Math.max(
      0,
      Math.floor(((config.maxMessageBytes - INLINE_ENVELOPE_SLACK_BYTES) * 3) / 4),
    );
    this.spillSinkFactory =
      spillSinkFactory ??
      (({ bucket, key, contentType }) => {
        if (!bucket) {
          throw new Error(
            "ingest body exceeds the inline limit but INGEST_OVERSIZE_BUCKET is not set for S3 offload",
          );
        }
        return this.createS3SpillSink(bucket, key, contentType);
      });
  }

  /** The admission lane a request with this declared `Content-Length` belongs in,
   *  using this queue's configured inline threshold. See
   *  {@link ingestLaneForContentLength}. */
  laneForContentLength(declaredContentLengthBytes: number | undefined): "buffer" | "upload" {
    return ingestLaneForContentLength(declaredContentLengthBytes, this.inlineRawThreshold);
  }

  async enqueue(input: IngestQueueInput): Promise<"inline" | "s3"> {
    const encoded = encodeIngestMessage(input, this.config);
    let uploadedObject: EncodedIngestMessage["s3Object"];

    try {
      if (encoded.s3Object) {
        uploadedObject = encoded.s3Object;
        await this.s3.send(
          new PutObjectCommand({
            Bucket: encoded.s3Object.bucket,
            Key: encoded.s3Object.key,
            Body: encoded.s3Object.body,
            ContentType: encoded.s3Object.contentType,
          }),
        );
      }

      await this.sendToQueue(encoded.messageBody);
      return encoded.storage;
    } catch (err) {
      if (uploadedObject) {
        await this.deleteS3Object(uploadedObject.bucket, uploadedObject.key).catch((deleteErr) => {
          this.logger.warn(
            { err: deleteErr, bucket: uploadedObject?.bucket, key: uploadedObject?.key },
            "failed to clean up oversize ingest object after enqueue failure",
          );
        });
      }
      throw err;
    }
  }

  /**
   * Stream a request body into the queue with bounded memory. Small bodies are
   * buffered and sent inline (delegating to {@link enqueue} for the exact
   * envelope-size decision); larger bodies stream straight to S3 via a multipart
   * upload so the proxy never holds the whole payload. Throws PayloadTooLargeError
   * for bodies over maxBodyBytes and EmptyBodyError for empty ones (the caller
   * maps these to 413 / 400).
   */
  async enqueueStream(input: {
    path: string;
    projectId: string;
    contentType: string;
    contentEncoding?: string;
    body: AsyncIterable<Uint8Array>;
  }): Promise<{ storage: "inline" | "s3"; bytes: number }> {
    const now = new Date();
    const datePrefix = now.toISOString().slice(0, 10).replaceAll("-", "/");
    const key = `${trimSlashes(this.config.oversizePrefix)}/${datePrefix}/${randomUUID()}.otlp`;
    const bucket = this.config.oversizeBucket;

    const result = await captureBody(input.body, {
      inlineThresholdBytes: this.inlineRawThreshold,
      maxBytes: this.config.maxBodyBytes,
      createSpillSink: () => this.spillSinkFactory({ bucket, key, contentType: input.contentType }),
    });

    if (result.storage === "buffer") {
      // Small enough to buffer: reuse the exact inline-vs-S3 envelope decision.
      const storage = await this.enqueue({
        path: input.path,
        projectId: input.projectId,
        contentType: input.contentType,
        contentEncoding: input.contentEncoding,
        body: result.buffer,
      });
      return { storage, bytes: result.totalBytes };
    }

    // Large body: already streamed to S3 by the sink. Enqueue the pointer.
    if (!bucket) throw new Error("spilled body has no oversize bucket configured");
    const message: IngestQueueMessage = {
      version: 1,
      kind: "otlp",
      path: input.path,
      projectId: input.projectId,
      contentType: input.contentType,
      contentEncoding: input.contentEncoding,
      receivedAt: now.toISOString(),
      body: { storage: "s3", bucket, key, sizeBytes: result.totalBytes },
    };
    try {
      await this.sendToQueue(JSON.stringify(message));
    } catch (err) {
      // The object already landed; clean up the orphan so a failed enqueue does
      // not leak S3 storage, mirroring enqueue()'s rollback.
      await this.deleteS3Object(bucket, key).catch((deleteErr) => {
        this.logger.warn(
          { err: deleteErr, bucket, key },
          "failed to clean up oversize ingest object after enqueue failure",
        );
      });
      throw err;
    }
    return { storage: "s3", bytes: result.totalBytes };
  }

  /**
   * A {@link SpillSink} backed by a streaming S3 multipart upload. Only one part
   * (SPILL_PART_SIZE_BYTES) is held in memory at a time, and `write` honors the
   * PassThrough's backpressure so a slow upload throttles the source read.
   */
  private createS3SpillSink(bucket: string, key: string, contentType: string): SpillSink {
    const pass = new PassThrough();
    const upload = new Upload({
      client: this.s3,
      params: { Bucket: bucket, Key: key, Body: pass, ContentType: contentType },
      partSize: SPILL_PART_SIZE_BYTES,
      queueSize: 1,
    });
    const done = upload.done();
    let uploadError: unknown;
    // If the upload fails, surface it on the stream so in-flight writes reject
    // instead of hanging; the trailing catch keeps `done` from going unhandled
    // before finish()/abort() observes it.
    done.catch((err) => {
      uploadError = err;
      if (!pass.destroyed) pass.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    return {
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          if (uploadError) {
            reject(uploadError);
            return;
          }
          const flushed = pass.write(chunk, (err) => {
            if (err) reject(err);
          });
          if (flushed) resolve();
          else pass.once("drain", resolve);
        }),
      finish: async () => {
        await new Promise<void>((resolve, reject) => {
          pass.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
        await done;
      },
      abort: async () => {
        try {
          await upload.abort();
        } catch {
          // best-effort; the multipart upload may not have started a part yet.
        }
        if (!pass.destroyed) pass.destroy();
      },
    };
  }

  // Producer-side micro-batching: pending sends accumulate here until a flush
  // (10 entries, the 256 KiB payload budget, or the linger timer) groups them
  // into SendMessageBatch calls. Every SQS request is billed individually, so at
  // ingest volume this cuts the request bill up to 10x for the price of at most
  // sendLingerMs of added ack latency.
  private pendingSends: PendingSend[] = [];
  private pendingSendBytes = 0;
  private sendFlushTimer: NodeJS.Timeout | null = null;
  private readonly inFlightSends = new Set<Promise<void>>();

  /** Resolves once this message body has been accepted by SQS (its batch entry
   *  succeeded); rejects with the entry/batch failure otherwise. */
  private sendToQueue(messageBody: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const bytes = Buffer.byteLength(messageBody);
      this.pendingSends.push({ messageBody, bytes, resolve, reject });
      this.pendingSendBytes += bytes;
      if (
        this.pendingSends.length >= SQS_BATCH_MAX_ENTRIES ||
        this.pendingSendBytes >= SQS_BATCH_MAX_PAYLOAD_BYTES
      ) {
        this.flushPendingSends();
      } else if (!this.sendFlushTimer) {
        this.sendFlushTimer = setTimeout(() => this.flushPendingSends(), this.config.sendLingerMs);
        // Never keep the process alive just for a pending flush; shutdown
        // flushes explicitly via stop().
        this.sendFlushTimer.unref?.();
      }
    });
  }

  private flushPendingSends(): void {
    if (this.sendFlushTimer) {
      clearTimeout(this.sendFlushTimer);
      this.sendFlushTimer = null;
    }
    const pending = this.pendingSends;
    this.pendingSends = [];
    this.pendingSendBytes = 0;
    if (pending.length === 0) return;

    // Greedy chunking under both SQS batch limits. A single message can be at
    // most maxMessageBytes (< the payload budget), so every entry fits somewhere.
    const chunks: PendingSend[][] = [];
    let current: PendingSend[] = [];
    let currentBytes = 0;
    for (const entry of pending) {
      if (
        current.length > 0 &&
        (current.length >= SQS_BATCH_MAX_ENTRIES ||
          currentBytes + entry.bytes > SQS_BATCH_MAX_PAYLOAD_BYTES)
      ) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(entry);
      currentBytes += entry.bytes;
    }
    if (current.length > 0) chunks.push(current);

    for (const chunk of chunks) {
      const sendPromise: Promise<void> = this.sendBatchChunk(chunk).finally(() => {
        this.inFlightSends.delete(sendPromise);
      });
      this.inFlightSends.add(sendPromise);
    }
  }

  private async sendBatchChunk(chunk: PendingSend[]): Promise<void> {
    try {
      const result = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.config.queueUrl,
          Entries: chunk.map((entry, index) => ({
            Id: String(index),
            MessageBody: entry.messageBody,
          })),
        }),
      );
      const failed = new Map((result.Failed ?? []).map((failure) => [failure.Id, failure]));
      chunk.forEach((entry, index) => {
        const failure = failed.get(String(index));
        if (failure) {
          entry.reject(
            new Error(
              `SQS batch entry failed: ${failure.Code ?? "unknown"}: ${failure.Message ?? "no message"}`,
            ),
          );
        } else {
          entry.resolve();
        }
      });
    } catch (err) {
      for (const entry of chunk) entry.reject(err);
    }
  }

  // Set by stop(); flips the consume loops out of their receive cycle so a
  // rolling deploy can drain cleanly instead of abandoning in-flight messages.
  private shuttingDown = false;
  // Healthy long polls are allowed to finish during shutdown. This controller
  // is aborted only after their configured server-side wait plus network slack,
  // bounding the drain if an HTTP connection stalls indefinitely.
  private readonly shutdownController = new AbortController();
  // Resolves once every consume loop has exited; stop() awaits it.
  private consumersDone: Promise<void> | null = null;

  startConsumer(collectorUrl: string): void {
    const loops = Array.from({ length: this.config.consumerConcurrency }, (_, index) =>
      this.consumeLoop(collectorUrl, index + 1),
    );
    // Surface an unexpected loop failure promptly: log it and flag a non-zero exit.
    for (const loop of loops) {
      loop.catch((err: unknown) => {
        this.logger.error({ err }, "ingest queue consumer stopped unexpectedly");
        process.exitCode = 1;
      });
    }
    // Resolve only once EVERY loop has settled. allSettled neither short-circuits
    // on the first rejection (so stop() never returns while a sibling loop is
    // still draining) nor rejects itself (so there is no unhandled rejection when
    // a loop fails and stop() is never called).
    this.consumersDone = Promise.allSettled(loops).then(() => undefined);
  }

  /**
   * Drain the consumer for a graceful shutdown (e.g. SIGTERM from an ECS rolling
   * deploy). Stops issuing new ReceiveMessage calls and waits for outstanding
   * long polls plus in-flight messages to finish — each delivered message is
   * deleted before its loop exits. Long polls must not be aborted immediately:
   * SQS can assign a message to a server-side receive after an immediate local
   * abort, leaving it invisible without a live client to receive its receipt
   * handle. A delayed abort after the normal poll window bounds genuinely
   * stalled connections. ECS's stop timeout comfortably exceeds that window.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info(
      { queueUrl: this.config.queueUrl },
      "ingest queue consumer draining in-flight messages",
    );
    // Flush any sends still waiting on the linger timer so a producer-only
    // proxy doesn't drop the tail of accepted requests on SIGTERM. The entry
    // promises are awaited by their HTTP handlers; allSettled only waits for
    // the wire calls to finish.
    this.flushPendingSends();
    await Promise.allSettled([...this.inFlightSends]);
    // consumersDone never rejects (see startConsumer); a loop failure is logged
    // and surfaced as a non-zero exit there. Give healthy receives their full
    // server-side long-poll window, then abort only a connection that is still
    // stalled beyond an additional network grace period.
    const abortTimer = this.consumersDone
      ? setTimeout(() => {
          this.logger.warn(
            { queueUrl: this.config.queueUrl },
            "aborting stalled SQS receive after shutdown drain deadline",
          );
          this.shutdownController.abort();
        }, this.config.waitTimeSeconds * 1_000 + SHUTDOWN_RECEIVE_ABORT_SLACK_MS)
      : null;
    abortTimer?.unref?.();
    try {
      await this.consumersDone;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
    this.logger.info({ queueUrl: this.config.queueUrl }, "ingest queue consumer drained");
  }

  private async consumeLoop(collectorUrl: string, consumerId: number): Promise<void> {
    this.logger.info(
      {
        queueUrl: this.config.queueUrl,
        consumerId,
        waitTimeSeconds: this.config.waitTimeSeconds,
        visibilityTimeoutSeconds: this.config.visibilityTimeoutSeconds,
        batchSize: this.config.batchSize,
      },
      "ingest queue consumer started",
    );

    while (!this.shuttingDown) {
      let result: ReceiveMessageCommandOutput;
      try {
        result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.queueUrl,
            MaxNumberOfMessages: this.config.batchSize,
            WaitTimeSeconds: this.config.waitTimeSeconds,
            VisibilityTimeout: this.config.visibilityTimeoutSeconds,
          }),
          { abortSignal: this.shutdownController.signal },
        );
      } catch (err) {
        if (this.shuttingDown && this.shutdownController.signal.aborted) break;
        throw err;
      }

      // A batch received just before stop() is still drained: we finish
      // processing (and deleting) it before the while-condition exits the loop.
      const messages = result.Messages ?? [];
      if (messages.length === 0) continue;

      const processed = await Promise.all(
        messages.map((message) => this.processMessage(message, collectorUrl)),
      );
      await this.deleteProcessedMessages(processed.filter((outcome) => outcome.shouldDelete));
    }

    this.logger.info(
      { queueUrl: this.config.queueUrl, consumerId },
      "ingest queue consumer stopped",
    );
  }

  /**
   * Forward one received message to the collector and report whether it should
   * be deleted from the queue. Deletion itself happens in batch back in the
   * consume loop (see {@link deleteProcessedMessages}); the optional s3Cleanup
   * is only acted on once the SQS delete for this message actually succeeded,
   * so a redelivered message can still read its offloaded body.
   */
  private async processMessage(message: Message, collectorUrl: string): Promise<ProcessedMessage> {
    const startedAt = performance.now();
    if (!message.Body) return { message, shouldDelete: false };

    let parsed: IngestQueueMessage | undefined;
    let collectorFailure: CollectorFailureDescription | undefined;

    try {
      parsed = parseIngestMessage(message.Body);

      const rawBody = await this.readMessageBody(parsed);
      // Stamp issue fingerprints here, off the proxy's ingest hot path. This deserializes
      // the payload (size-guarded + fail-open inside the helper); a slow/OOM here only
      // redelivers an SQS message rather than 502-ing live ingest traffic.
      const body = stampIssueFingerprintsFailOpen(
        {
          path: parsed.path,
          contentType: parsed.contentType,
          contentEncoding: parsed.contentEncoding,
          body: rawBody,
          projectId: parsed.projectId,
        },
        this.logger,
      );

      // Direct-to-ClickHouse path (INGEST_CLICKHOUSE_DIRECT). Map the OTLP body to rows
      // and INSERT synchronously with quorum; the message is deleted only if the insert
      // succeeds (a throw falls through to the catch and the message redelivers). Signals
      // we don't yet write directly (metrics) and bodies we can't decode return null and
      // fall through to the collector forward below, so nothing is ever dropped.
      if (this.rowWriter) {
        // Decoding is best-effort: a malformed/undecodable payload returns null OR throws,
        // and either way we fall through to the collector forward below rather than failing
        // the message (which would churn it through retries to the DLQ). Only the INSERT is
        // allowed to throw — a ClickHouse failure should redeliver, not drop.
        let decoded: DecodedRows | null = null;
        try {
          decoded = decodeOtlpToRows({
            path: parsed.path,
            projectId: parsed.projectId,
            contentType: parsed.contentType,
            contentEncoding: parsed.contentEncoding,
            body,
          });
        } catch (decodeErr) {
          this.logger.warn(
            { err: decodeErr, path: parsed.path, projectId: parsed.projectId },
            "direct-write decode failed; forwarding to collector",
          );
        }
        if (decoded) {
          await this.rowWriter.insert(decoded.table, decoded.rows);
          proxyOperationalRecorder.recordQueueDelivery({
            path: parsed.path,
            projectId: parsed.projectId,
            storage: parsed.body.storage,
            outcome: "delivered",
            durationMs: performance.now() - startedAt,
            ageMs: ageMs(parsed.receivedAt),
          });
          this.logger.info(
            {
              path: parsed.path,
              projectId: parsed.projectId,
              storage: parsed.body.storage,
              target: "clickhouse",
              rows: decoded.rows.length,
            },
            "delivered queued ingest payload",
          );
          return {
            message,
            shouldDelete: true,
            s3Cleanup:
              parsed.body.storage === "s3"
                ? { bucket: parsed.body.bucket, key: parsed.body.key }
                : undefined,
          };
        }
      }

      const headers: Record<string, string> = {
        "content-type": parsed.contentType,
        "x-superlog-project-id": parsed.projectId,
      };
      if (parsed.contentEncoding) headers["content-encoding"] = parsed.contentEncoding;

      const response = await fetch(`${collectorUrl}${parsed.path}`, {
        method: "POST",
        headers,
        body,
      });
      if (!response.ok) {
        collectorFailure = describeCollectorFailure(
          response.status,
          await readResponseBodyForLog(response),
        );
        throw new Error(collectorFailure.message);
      }

      proxyOperationalRecorder.recordQueueDelivery({
        path: parsed.path,
        projectId: parsed.projectId,
        storage: parsed.body.storage,
        outcome: "delivered",
        collectorStatusCode: response.status,
        durationMs: performance.now() - startedAt,
        ageMs: ageMs(parsed.receivedAt),
      });

      this.logger.info(
        {
          path: parsed.path,
          projectId: parsed.projectId,
          storage: parsed.body.storage,
          status: response.status,
        },
        "delivered queued ingest payload",
      );

      return {
        message,
        shouldDelete: true,
        s3Cleanup:
          parsed.body.storage === "s3"
            ? { bucket: parsed.body.bucket, key: parsed.body.key }
            : undefined,
      };
    } catch (err) {
      const poison = isPoisonMessageError(err);
      // A collector 4xx (other than 408/429) rejects these exact bytes permanently, so it
      // is as undeliverable as a poison envelope — drop it instead of cycling it to the DLQ.
      const permanentCollectorRejection =
        !poison && collectorFailure !== undefined && isPermanentCollectorFailure(collectorFailure.status);
      const drop = poison || permanentCollectorRejection;
      const metric = queueDeliveryMetricFromParsedMessage(
        parsed,
        poison ? "invalid_message" : collectorFailure ? "collector_error" : "delivery_error",
        collectorFailure?.status,
        performance.now() - startedAt,
        parsed && typeof parsed === "object" && "receivedAt" in parsed
          ? ageMs((parsed as { receivedAt?: unknown }).receivedAt)
          : undefined,
      );
      if (metric) {
        proxyOperationalRecorder.recordQueueDelivery(metric);
      }
      this.logger.warn(
        {
          err,
          poison,
          permanentCollectorRejection,
          messageId: message.MessageId,
          collectorStatus: collectorFailure?.status,
          collectorResponseBody: collectorFailure?.body,
          path: parsed?.path,
          projectId: parsed?.projectId,
          contentType: parsed?.contentType,
          contentEncoding: parsed?.contentEncoding,
          storage: parsed?.body?.storage,
          s3SizeBytes: parsed?.body?.storage === "s3" ? parsed.body.sizeBytes : undefined,
          inlineBodyBase64Bytes:
            parsed?.body?.storage === "inline" ? Buffer.byteLength(parsed.body.base64 ?? "") : undefined,
        },
        poison
          ? "dropping poison ingest message"
          : permanentCollectorRejection
            ? "dropping ingest message permanently rejected by collector"
            : "failed to deliver queued ingest payload",
      );

      // An undeliverable message (poison envelope or permanent collector 4xx) can never
      // succeed; leaving it in place means 50 redeliveries (15-min visibility each) before
      // it reaches the DLQ, which pins oldest-message-age into a sawtooth and keeps the bad
      // payload churning in-flight. Mark it for deletion so it stops cycling; the S3 body
      // is only purged once the SQS delete actually succeeded (see deleteProcessedMessages).
      return {
        message,
        shouldDelete: drop,
        s3Cleanup:
          drop && parsed?.body?.storage === "s3" && parsed.body.bucket && parsed.body.key
            ? { bucket: parsed.body.bucket, key: parsed.body.key }
            : undefined,
      };
    }
  }

  /**
   * Delete a processed batch of messages with DeleteMessageBatch (one billed
   * request per 10 messages instead of one per message). A failed entry is only
   * logged — the message redelivers after its visibility timeout, which at worst
   * forwards the same payload to the collector twice; its offloaded S3 body is
   * kept so the retry can still read it.
   */
  private async deleteProcessedMessages(outcomes: ProcessedMessage[]): Promise<void> {
    const deletable = outcomes.filter((outcome) => {
      if (outcome.message.ReceiptHandle) return true;
      this.logger.warn(
        { messageId: outcome.message.MessageId },
        "SQS message is missing receipt handle; it cannot be deleted",
      );
      return false;
    });

    for (let offset = 0; offset < deletable.length; offset += SQS_BATCH_MAX_ENTRIES) {
      const chunk = deletable.slice(offset, offset + SQS_BATCH_MAX_ENTRIES);
      let failedIds: Set<string | undefined>;
      try {
        const result = await this.sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: this.config.queueUrl,
            Entries: chunk.map((outcome, index) => ({
              Id: String(index),
              ReceiptHandle: outcome.message.ReceiptHandle,
            })),
          }),
        );
        failedIds = new Set((result.Failed ?? []).map((failure) => failure.Id));
      } catch (err) {
        this.logger.warn(
          { err, count: chunk.length },
          "failed to delete processed ingest messages; they will be redelivered",
        );
        continue;
      }

      await Promise.all(
        chunk.map(async (outcome, index) => {
          if (failedIds.has(String(index))) {
            this.logger.warn(
              { messageId: outcome.message.MessageId },
              "failed to delete processed ingest message; it will be redelivered",
            );
            return;
          }
          if (outcome.s3Cleanup) {
            await this.deleteS3Object(outcome.s3Cleanup.bucket, outcome.s3Cleanup.key).catch(
              (err) => {
                this.logger.warn(
                  { err, ...outcome.s3Cleanup },
                  "failed to delete oversize ingest object after delivery",
                );
              },
            );
          }
        }),
      );
    }
  }

  private async readMessageBody(message: IngestQueueMessage): Promise<Buffer> {
    if (message.body.storage === "inline") {
      return Buffer.from(message.body.base64, "base64");
    }

    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: message.body.bucket,
        Key: message.body.key,
      }),
    );
    return getObjectBodyToBuffer(result.Body);
  }

  private async deleteS3Object(bucket: string, key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

async function readResponseBodyForLog(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function getObjectBodyToBuffer(body: GetObjectCommandOutput["Body"]): Promise<Buffer> {
  if (!body) throw new Error("S3 object response is missing body");
  if ("transformToByteArray" in body && typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function assertIngestMessage(message: IngestQueueMessage): void {
  if (message.version !== 1 || message.kind !== "otlp") {
    throw new PoisonMessageError("unsupported ingest queue message");
  }
  if (!message.path.startsWith("/v1/")) {
    throw new PoisonMessageError(`invalid ingest queue path: ${message.path}`);
  }
  if (!message.projectId || !message.contentType) {
    throw new PoisonMessageError("ingest queue message is missing required metadata");
  }
  if (message.body.storage === "inline" && !message.body.base64) {
    throw new PoisonMessageError("inline ingest queue message is missing body");
  }
  if (message.body.storage === "s3" && (!message.body.bucket || !message.body.key)) {
    throw new PoisonMessageError("s3 ingest queue message is missing object pointer");
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function ageMs(receivedAt: unknown): number | undefined {
  if (typeof receivedAt !== "string") return undefined;
  const parsed = Date.parse(receivedAt);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : undefined;
}

export function queueDeliveryMetricFromParsedMessage(
  parsed: unknown,
  outcome: QueueDeliveryMetric["outcome"],
  collectorStatusCode: number | undefined,
  durationMs: number,
  messageAgeMs: number | undefined,
): QueueDeliveryMetric | null {
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as {
    path?: unknown;
    projectId?: unknown;
    body?: { storage?: unknown };
  };
  if (typeof message.path !== "string" || typeof message.projectId !== "string") return null;
  const storage = message.body?.storage;
  if (storage !== "inline" && storage !== "s3") return null;
  return {
    path: message.path,
    projectId: message.projectId,
    storage,
    outcome,
    collectorStatusCode,
    durationMs,
    ageMs: messageAgeMs,
  };
}
