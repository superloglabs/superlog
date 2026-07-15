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
  s3MaxSockets: 128,
  sqsMaxSockets: 64,
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
 * Models the shutdown race at the SQS boundary. A long poll may still be live
 * server-side when a client aborts it. If SQS assigns a message after that
 * abort, the message is invisible but the dead client never receives its
 * receipt handle. Keeping the client request alive lets the consumer process
 * and delete that final message before it exits.
 */
class FakeLongPollSqs {
  receiveCount = 0;
  deleted: string[] = [];
  aborted = false;
  private resolveReceive: ((value: unknown) => void) | null = null;

  // biome-ignore lint/suspicious/noExplicitAny: minimal AWS client test double
  async send(cmd: any, opts?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const name = cmd.constructor.name;
    if (name === "ReceiveMessageCommand") {
      this.receiveCount++;
      return await new Promise((resolve, reject) => {
        this.resolveReceive = resolve;
        const abort = () => {
          this.aborted = true;
          const err = new Error("Request aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (opts?.abortSignal?.aborted) return abort();
        opts?.abortSignal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (name === "DeleteMessageBatchCommand") {
      const entries = cmd.input.Entries as Array<{ Id: string; ReceiptHandle: string }>;
      for (const entry of entries) this.deleted.push(entry.ReceiptHandle);
      return { Successful: entries.map((entry) => ({ Id: entry.Id })), Failed: [] };
    }
    throw new Error(`unexpected SQS command: ${name}`);
  }

  deliverDuringShutdown(): void {
    this.resolveReceive?.({
      Messages: [{ MessageId: "m-1", ReceiptHandle: "r-1", Body: inlineBody }],
    });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(5);
  }
}

test("stop() drains a message assigned to an outstanding long poll during shutdown", async () => {
  const queue = new IngestQueue(config, noopLogger);
  const sqs = new FakeLongPollSqs();
  (queue as unknown as { sqs: FakeLongPollSqs }).sqs = sqs;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(0), { status: 200 })) as typeof fetch;

  try {
    queue.startConsumer("http://collector.local");
    await waitFor(() => sqs.receiveCount === 1);

    const stopping = queue.stop();
    sqs.deliverDuringShutdown();
    await stopping;

    assert.equal(sqs.aborted, false, "shutdown must not abandon the outstanding SQS long poll");
    assert.deepEqual(sqs.deleted, ["r-1"], "the final message must be delivered and deleted");
    assert.equal(
      sqs.receiveCount,
      1,
      "the consumer must not start another poll while shutting down",
    );

    // stop() is idempotent.
    await queue.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
