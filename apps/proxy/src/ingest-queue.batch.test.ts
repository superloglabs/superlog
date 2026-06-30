import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { IngestQueue, type IngestQueueConfig, getIngestQueueConfig } from "./ingest-queue.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

// The producer's micro-batch flush timer is unref()'d (see IngestQueue.sendToQueue)
// so a producer-only proxy never stays alive just for a pending flush. In prod the
// HTTP server keeps the event loop alive and the timer fires; under the bare test
// runner there is no other handle, so the loop would drain before the unref'd timer
// fires and the enqueue() promises would never settle ("Promise resolution is still
// pending but the event loop has already resolved"). A single ref'd keepalive for the
// duration of the suite reproduces prod's "loop stays alive" condition.
let suiteKeepAlive: NodeJS.Timeout;
before(() => {
  suiteKeepAlive = setInterval(() => {}, 60_000);
});
after(() => {
  clearInterval(suiteKeepAlive);
});

function buildConfig(overrides: Partial<IngestQueueConfig> = {}): IngestQueueConfig {
  return {
    queueUrl: "http://localhost/queue",
    region: "us-west-2",
    oversizePrefix: "otlp-oversize",
    maxMessageBytes: 240_000,
    maxBodyBytes: 64 * 1024 * 1024,
    consumerEnabled: true,
    waitTimeSeconds: 20,
    visibilityTimeoutSeconds: 120,
    batchSize: 10,
    consumerConcurrency: 1,
    sendLingerMs: 5,
    s3MaxSockets: 128,
    sqsMaxSockets: 64,
    ...overrides,
  };
}

function input(projectId: string, body: Buffer = Buffer.from(`body-${projectId}`)) {
  return {
    path: "/v1/logs",
    projectId,
    contentType: "application/x-protobuf",
    body,
  };
}

/** Fake SQS for the producer side: accepts SendMessageBatch, records every batch,
 *  and fails entries whose MessageBody contains `failBodiesContaining`. A plain
 *  SendMessageCommand is an error — the whole point is that sends are batched. */
class FakeSendSqs {
  batchEntries: Array<Array<{ Id: string; MessageBody: string }>> = [];
  failBodiesContaining: string | null = null;

  // biome-ignore lint/suspicious/noExplicitAny: minimal AWS client test double
  async send(cmd: any): Promise<unknown> {
    const name = cmd.constructor.name;
    if (name === "SendMessageBatchCommand") {
      const entries = cmd.input.Entries as Array<{ Id: string; MessageBody: string }>;
      this.batchEntries.push(entries);
      const marker = this.failBodiesContaining;
      const failed = marker ? entries.filter((e) => e.MessageBody.includes(marker)) : [];
      return {
        Successful: entries.filter((e) => !failed.includes(e)).map((e) => ({ Id: e.Id })),
        Failed: failed.map((e) => ({
          Id: e.Id,
          Code: "InternalError",
          Message: "simulated entry failure",
          SenderFault: false,
        })),
      };
    }
    throw new Error(`unexpected SQS command: ${name}`);
  }
}

class FakeS3 {
  puts: string[] = [];
  deletes: string[] = [];
  objects = new Map<string, Buffer>();

  // biome-ignore lint/suspicious/noExplicitAny: minimal AWS client test double
  async send(cmd: any): Promise<unknown> {
    const name = cmd.constructor.name;
    if (name === "PutObjectCommand") {
      this.puts.push(cmd.input.Key);
      return {};
    }
    if (name === "DeleteObjectCommand") {
      this.deletes.push(cmd.input.Key);
      return {};
    }
    if (name === "GetObjectCommand") {
      const body = this.objects.get(cmd.input.Key);
      if (!body) throw new Error(`no such object: ${cmd.input.Key}`);
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    throw new Error(`unexpected S3 command: ${name}`);
  }
}

function buildQueue(overrides: Partial<IngestQueueConfig> = {}) {
  const queue = new IngestQueue(buildConfig(overrides), noopLogger);
  const sqs = new FakeSendSqs();
  const s3 = new FakeS3();
  (queue as unknown as { sqs: FakeSendSqs }).sqs = sqs;
  (queue as unknown as { s3: FakeS3 }).s3 = s3;
  return { queue, sqs, s3 };
}

test("getIngestQueueConfig reads the send linger with a batching default", () => {
  const defaults = getIngestQueueConfig({ INGEST_QUEUE_URL: "http://localhost/queue" });
  assert.equal(defaults?.sendLingerMs, 50);

  const zero = getIngestQueueConfig({
    INGEST_QUEUE_URL: "http://localhost/queue",
    INGEST_QUEUE_SEND_LINGER_MS: "0",
  });
  assert.equal(zero?.sendLingerMs, 0);
});

test("enqueue coalesces concurrent sends into one SendMessageBatch", async () => {
  const { queue, sqs } = buildQueue();

  const results = await Promise.all([1, 2, 3].map((i) => queue.enqueue(input(`p-${i}`))));

  assert.deepEqual(results, ["inline", "inline", "inline"]);
  assert.equal(sqs.batchEntries.length, 1, "three concurrent sends must share one batch call");
  assert.equal(sqs.batchEntries[0]?.length, 3);
});

test("a full batch of 10 flushes immediately without waiting for the linger timer", async () => {
  const { queue, sqs } = buildQueue({ sendLingerMs: 5_000 });

  const pending = Array.from({ length: 10 }, (_, i) => queue.enqueue(input(`p-${i}`)));
  // Well under the 5s linger: the batch must already be on the wire.
  await delay(50);
  assert.equal(sqs.batchEntries.length, 1);
  assert.equal(sqs.batchEntries[0]?.length, 10);
  await Promise.all(pending);
});

test("splits a flush into multiple batch calls when the 256 KiB payload budget would overflow", async () => {
  const { queue, sqs } = buildQueue();

  // Three ~107 KiB message bodies (80 KB raw, base64-inflated): two fit in one
  // 256 KiB SendMessageBatch, the third must roll into a second call.
  await Promise.all(
    [1, 2, 3].map((i) => queue.enqueue(input(`p-${i}`, Buffer.alloc(80_000, i)))),
  );

  assert.equal(sqs.batchEntries.length, 2, "three oversized entries must split into two batches");
  const totalEntries = sqs.batchEntries.reduce((n, entries) => n + entries.length, 0);
  assert.equal(totalEntries, 3);
  for (const entries of sqs.batchEntries) {
    const bytes = entries.reduce((n, e) => n + Buffer.byteLength(e.MessageBody), 0);
    assert.ok(bytes <= 256 * 1024, `batch payload ${bytes} exceeds the SQS 256 KiB budget`);
  }
});

test("rejects only the entries SQS reports as failed", async () => {
  const { queue, sqs } = buildQueue();
  sqs.failBodiesContaining = "p-doomed";

  const ok = queue.enqueue(input("p-fine"));
  const doomed = queue.enqueue(input("p-doomed"));

  assert.equal(await ok, "inline");
  await assert.rejects(doomed, /simulated entry failure/);
});

test("cleans up the uploaded S3 object when its batched send fails", async () => {
  const { queue, sqs, s3 } = buildQueue({
    maxMessageBytes: 64, // force the S3 offload path
    oversizeBucket: "test-bucket",
  });
  sqs.failBodiesContaining = "p-doomed";

  await assert.rejects(queue.enqueue(input("p-doomed")), /simulated entry failure/);

  assert.equal(s3.puts.length, 1, "the oversize body must be uploaded before the send");
  assert.deepEqual(s3.deletes, s3.puts, "the orphaned object must be rolled back");
});

/** Fake SQS for the consumer side: delivers one fixed batch on the first receive,
 *  then blocks like a real long-poll until aborted. Deletes must arrive as
 *  DeleteMessageBatch; entries whose receipt handle is in `failReceipts` fail. */
class FakeConsumerSqs {
  deleteBatches: string[][] = [];
  singleDeletes: string[] = [];
  failReceipts: string[] = [];
  private delivered = false;

  constructor(private readonly messages: Array<{ MessageId: string; ReceiptHandle: string; Body: string }>) {}

  // biome-ignore lint/suspicious/noExplicitAny: minimal AWS client test double
  async send(cmd: any, opts?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const name = cmd.constructor.name;
    if (name === "ReceiveMessageCommand") {
      if (!this.delivered) {
        this.delivered = true;
        return { Messages: this.messages };
      }
      return await new Promise((_resolve, reject) => {
        const signal = opts?.abortSignal;
        const abort = () => {
          const err = new Error("Request aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (name === "DeleteMessageBatchCommand") {
      const entries = cmd.input.Entries as Array<{ Id: string; ReceiptHandle: string }>;
      this.deleteBatches.push(entries.map((e) => e.ReceiptHandle));
      const failed = entries.filter((e) => this.failReceipts.includes(e.ReceiptHandle));
      return {
        Successful: entries.filter((e) => !failed.includes(e)).map((e) => ({ Id: e.Id })),
        Failed: failed.map((e) => ({
          Id: e.Id,
          Code: "ReceiptHandleIsInvalid",
          Message: "simulated delete failure",
          SenderFault: true,
        })),
      };
    }
    if (name === "DeleteMessageCommand") {
      this.singleDeletes.push(cmd.input.ReceiptHandle);
      return {};
    }
    throw new Error(`unexpected SQS command: ${name}`);
  }
}

function inlineMessageBody(projectId: string): string {
  return JSON.stringify({
    version: 1,
    kind: "otlp",
    path: "/v1/logs",
    projectId,
    contentType: "application/x-protobuf",
    receivedAt: new Date().toISOString(),
    body: { storage: "inline", base64: Buffer.from("hello").toString("base64") },
  });
}

function s3MessageBody(projectId: string, key: string): string {
  return JSON.stringify({
    version: 1,
    kind: "otlp",
    path: "/v1/logs",
    projectId,
    contentType: "application/x-protobuf",
    receivedAt: new Date().toISOString(),
    body: { storage: "s3", bucket: "test-bucket", key, sizeBytes: 5 },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(5);
  }
}

async function withCollectorReturning(
  status: number,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array(0), { status })) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("consumer deletes a processed batch with one DeleteMessageBatch call", async () => {
  const sqs = new FakeConsumerSqs([
    { MessageId: "m-1", ReceiptHandle: "r-1", Body: inlineMessageBody("p-1") },
    { MessageId: "m-2", ReceiptHandle: "r-2", Body: inlineMessageBody("p-2") },
    { MessageId: "m-3", ReceiptHandle: "r-3", Body: inlineMessageBody("p-3") },
  ]);
  const queue = new IngestQueue(buildConfig(), noopLogger);
  (queue as unknown as { sqs: FakeConsumerSqs }).sqs = sqs;

  await withCollectorReturning(200, async () => {
    queue.startConsumer("http://collector.local");
    await waitFor(() => sqs.deleteBatches.length === 1);
    await queue.stop();
  });

  assert.deepEqual(sqs.deleteBatches, [["r-1", "r-2", "r-3"]]);
  assert.equal(sqs.singleDeletes.length, 0, "deletes must be batched, not per-message");
});

test("poison messages are dropped through the same batched delete", async () => {
  const sqs = new FakeConsumerSqs([
    { MessageId: "m-1", ReceiptHandle: "r-1", Body: inlineMessageBody("p-1") },
    { MessageId: "m-2", ReceiptHandle: "r-2", Body: "not json at all" },
  ]);
  const queue = new IngestQueue(buildConfig(), noopLogger);
  (queue as unknown as { sqs: FakeConsumerSqs }).sqs = sqs;

  await withCollectorReturning(200, async () => {
    queue.startConsumer("http://collector.local");
    await waitFor(() => sqs.deleteBatches.length === 1);
    await queue.stop();
  });

  assert.deepEqual(sqs.deleteBatches, [["r-1", "r-2"]]);
});

test("keeps the S3 body when its SQS delete fails so the redelivery can still read it", async () => {
  const sqs = new FakeConsumerSqs([
    { MessageId: "m-1", ReceiptHandle: "r-1", Body: s3MessageBody("p-1", "k-1") },
    { MessageId: "m-2", ReceiptHandle: "r-2", Body: s3MessageBody("p-2", "k-2") },
  ]);
  sqs.failReceipts = ["r-2"];
  const queue = new IngestQueue(buildConfig(), noopLogger);
  const s3 = new FakeS3();
  s3.objects.set("k-1", Buffer.from("hello"));
  s3.objects.set("k-2", Buffer.from("hello"));
  (queue as unknown as { sqs: FakeConsumerSqs }).sqs = sqs;
  (queue as unknown as { s3: FakeS3 }).s3 = s3;

  await withCollectorReturning(200, async () => {
    queue.startConsumer("http://collector.local");
    await waitFor(() => sqs.deleteBatches.length === 1);
    await queue.stop();
  });

  assert.deepEqual(s3.deletes, ["k-1"], "only the successfully-deleted message may purge its body");
});

test("stop() flushes pending batched sends before resolving", async () => {
  const { queue, sqs } = buildQueue({ sendLingerMs: 60_000 });

  const pending = queue.enqueue(input("p-1"));
  // The linger is 60s; stop() must not wait for it.
  await queue.stop();

  assert.equal(await pending, "inline");
  assert.equal(sqs.batchEntries.length, 1);
});
