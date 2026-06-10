import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { IngestQueue, type IngestQueueConfig, encodeIngestMessage } from "./ingest-queue.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const config: IngestQueueConfig = {
  queueUrl: "http://localhost/queue",
  region: "us-west-2",
  oversizePrefix: "otlp-oversize",
  maxMessageBytes: 240_000,
  maxBodyBytes: 10_000,
  consumerEnabled: true,
  waitTimeSeconds: 20,
  visibilityTimeoutSeconds: 120,
  batchSize: 1,
  consumerConcurrency: 1,
  sendLingerMs: 0,
};

const inlineBody = encodeIngestMessage(
  {
    path: "/v1/logs",
    projectId: "project-1",
    contentType: "application/x-protobuf",
    body: Buffer.from("hello"),
  },
  config,
).messageBody;

/**
 * Fake SQS that delivers exactly one message on the first ReceiveMessage and
 * then blocks (like a real 20s long-poll) until the consumer's AbortController
 * fires — at which point it rejects with an AbortError, exactly as the AWS SDK
 * does when send() is aborted. Records every DeleteMessage.
 */
class FakeConsumerSqs {
  receiveCount = 0;
  deleted: string[] = [];
  private delivered = false;

  // biome-ignore lint/suspicious/noExplicitAny: minimal AWS client test double
  async send(cmd: any, opts?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const name = cmd.constructor.name;
    if (name === "ReceiveMessageCommand") {
      this.receiveCount++;
      if (!this.delivered) {
        this.delivered = true;
        return {
          Messages: [{ MessageId: "m-1", ReceiptHandle: "r-1", Body: inlineBody }],
        };
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
      for (const entry of entries) this.deleted.push(entry.ReceiptHandle);
      return { Successful: entries.map((entry) => ({ Id: entry.Id })), Failed: [] };
    }
    throw new Error(`unexpected SQS command: ${name}`);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(5);
  }
}

test("stop() drains the in-flight message and halts polling", async () => {
  const queue = new IngestQueue(config, noopLogger);
  const sqs = new FakeConsumerSqs();
  (queue as unknown as { sqs: FakeConsumerSqs }).sqs = sqs;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(0), { status: 200 })) as typeof fetch;

  try {
    queue.startConsumer("http://collector.local");

    // The first delivered message must be forwarded to the collector and then
    // deleted from SQS before we initiate shutdown.
    await waitFor(() => sqs.deleted.length === 1);
    assert.deepEqual(sqs.deleted, ["r-1"]);

    const receivesBeforeStop = sqs.receiveCount;
    await queue.stop();

    // After draining, the loop must not issue any further ReceiveMessage calls.
    await delay(50);
    assert.equal(
      sqs.receiveCount,
      receivesBeforeStop,
      "consumer must stop polling once stop() resolves",
    );
    assert.equal(sqs.deleted.length, 1, "the in-flight message must remain deleted exactly once");

    // stop() is idempotent.
    await queue.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
