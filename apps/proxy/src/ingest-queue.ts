import { randomUUID } from "node:crypto";
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
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { Upload } from "@aws-sdk/lib-storage";
import { type SpillSink, captureBody } from "./body-capture.js";
import { stampIssueFingerprintsFailOpen } from "./ingest-fingerprints.js";
import { proxyOperationalRecorder } from "./operational-metrics.js";

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
const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 120;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_CONSUMER_CONCURRENCY = 4;
const MAX_COLLECTOR_ERROR_BODY_CHARS = 1_000;

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
};

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

export class IngestQueue {
  private readonly sqs: SQSClient;
  private readonly s3: S3Client;
  // Raw-byte threshold below which a body's base64 inline envelope still fits
  // within maxMessageBytes. Bodies at or under this are buffered in memory and
  // sent inline; larger ones stream to S3. Derived from the SQS message budget.
  private readonly inlineRawThreshold: number;
  private readonly spillSinkFactory: SpillSinkFactory;

  constructor(
    private readonly config: IngestQueueConfig,
    private readonly logger: LoggerLike,
    spillSinkFactory?: SpillSinkFactory,
  ) {
    const clientConfig = config.region ? { region: config.region } : {};
    this.sqs = new SQSClient(clientConfig);
    this.s3 = new S3Client(clientConfig);
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

      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.config.queueUrl,
          MessageBody: encoded.messageBody,
        }),
      );
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
      await this.sqs.send(
        new SendMessageCommand({ QueueUrl: this.config.queueUrl, MessageBody: JSON.stringify(message) }),
      );
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

  startConsumer(collectorUrl: string): void {
    void Promise.all(
      Array.from({ length: this.config.consumerConcurrency }, (_, index) =>
        this.consumeLoop(collectorUrl, index + 1),
      ),
    ).catch((err: unknown) => {
      this.logger.error({ err }, "ingest queue consumer stopped unexpectedly");
      process.exitCode = 1;
    });
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

    for (;;) {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.config.queueUrl,
          MaxNumberOfMessages: this.config.batchSize,
          WaitTimeSeconds: this.config.waitTimeSeconds,
          VisibilityTimeout: this.config.visibilityTimeoutSeconds,
        }),
      );

      const messages = result.Messages ?? [];
      if (messages.length === 0) continue;

      await Promise.all(messages.map((message) => this.processMessage(message, collectorUrl)));
    }
  }

  private async processMessage(message: Message, collectorUrl: string): Promise<void> {
    const startedAt = performance.now();
    if (!message.Body) return;

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

      if (!message.ReceiptHandle) throw new Error("SQS message is missing receipt handle");
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.config.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );

      if (parsed.body.storage === "s3") {
        await this.deleteS3Object(parsed.body.bucket, parsed.body.key);
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
      // payload churning in-flight. Delete it immediately so it stops cycling.
      if (drop && message.ReceiptHandle) {
        const sqsDeleted = await this.sqs
          .send(
            new DeleteMessageCommand({
              QueueUrl: this.config.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          )
          .then(() => true)
          .catch((deleteErr: unknown) => {
            this.logger.warn(
              { err: deleteErr, messageId: message.MessageId },
              "failed to delete undeliverable ingest message",
            );
            return false;
          });
        // Only purge the S3 body once the queue message is actually gone. If the SQS delete
        // failed, the message will be redelivered after the visibility timeout and still needs
        // its body — deleting it here would strand the retry with a missing object until the DLQ.
        if (sqsDeleted && parsed?.body?.storage === "s3" && parsed.body.bucket && parsed.body.key) {
          await this.deleteS3Object(parsed.body.bucket, parsed.body.key).catch(() => {});
        }
      }
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
