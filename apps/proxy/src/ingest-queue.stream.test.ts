import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { PayloadTooLargeError, type SpillSink } from "./body-capture.js";
import { IngestQueue, type IngestQueueConfig, type SpillSinkFactory } from "./ingest-queue.js";

// The producer's micro-batch flush timer is unref()'d (see IngestQueue.sendToQueue),
// so under the bare test runner the event loop can drain before the timer fires and
// an enqueue() promise would never settle ("Promise resolution is still pending but
// the event loop has already resolved"). Whether it drains in time depends on
// incidental module-load timing, so pin prod's "the HTTP server keeps the loop alive"
// condition with a single ref'd keepalive for the suite. Mirrors ingest-queue.batch.test.ts.
let suiteKeepAlive: NodeJS.Timeout;
before(() => {
  suiteKeepAlive = setInterval(() => {}, 60_000);
});
after(() => {
  clearInterval(suiteKeepAlive);
});

class FakeSqs {
  sent: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test double for the AWS client surface
  async send(cmd: any): Promise<unknown> {
    if (cmd.constructor.name !== "SendMessageBatchCommand") {
      throw new Error(`unexpected SQS command: ${cmd.constructor.name}`);
    }
    const entries = cmd.input.Entries as Array<{ Id: string; MessageBody: string }>;
    for (const entry of entries) this.sent.push(entry.MessageBody);
    return { Successful: entries.map((entry) => ({ Id: entry.Id })), Failed: [] };
  }
}

class RecordingSink implements SpillSink {
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

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function buildQueue(overrides: Partial<IngestQueueConfig> = {}): {
  queue: IngestQueue;
  sqs: FakeSqs;
  sinks: RecordingSink[];
} {
  const config: IngestQueueConfig = {
    queueUrl: "http://localhost/queue",
    region: "us-west-2",
    oversizeBucket: "test-bucket",
    oversizePrefix: "otlp-oversize",
    maxMessageBytes: 4000, // inline raw threshold ≈ floor((4000-1024)*3/4) = 2232 bytes
    maxBodyBytes: 10_000,
    consumerEnabled: false,
    waitTimeSeconds: 20,
    visibilityTimeoutSeconds: 120,
    batchSize: 10,
    consumerConcurrency: 4,
    sendLingerMs: 0,
    s3MaxSockets: 128,
    sqsMaxSockets: 64,
    ...overrides,
  };
  const sinks: RecordingSink[] = [];
  const spillSinkFactory: SpillSinkFactory = () => {
    const sink = new RecordingSink();
    sinks.push(sink);
    return sink;
  };
  const queue = new IngestQueue(config, noopLogger, spillSinkFactory);
  const sqs = new FakeSqs();
  (queue as unknown as { sqs: FakeSqs }).sqs = sqs;
  return { queue, sqs, sinks };
}

async function* streamOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk);
}

test("small body is buffered and enqueued inline, never opening a spill sink", async () => {
  const { queue, sqs, sinks } = buildQueue();
  const result = await queue.enqueueStream({
    path: "/v1/traces",
    projectId: "proj-1",
    contentType: "application/x-protobuf",
    body: streamOf("hello world"),
  });

  assert.equal(result.storage, "inline");
  assert.equal(result.bytes, 11);
  assert.equal(sinks.length, 0, "small body must not spill");
  assert.equal(sqs.sent.length, 1);
  const sent = sqs.sent[0];
  assert.ok(sent);
  const msg = JSON.parse(sent);
  assert.equal(msg.body.storage, "inline");
  assert.equal(Buffer.from(msg.body.base64, "base64").toString(), "hello world");
});

test("large body streams to the spill sink and enqueues an s3 pointer with the byte count", async () => {
  const { queue, sqs, sinks } = buildQueue();
  // 3000 raw bytes > the ~2232 inline threshold → spills.
  const chunk = "X".repeat(1000);
  const result = await queue.enqueueStream({
    path: "/v1/traces",
    projectId: "proj-1",
    contentType: "application/x-protobuf",
    body: streamOf(chunk, chunk, chunk),
  });

  assert.equal(result.storage, "s3");
  assert.equal(result.bytes, 3000);
  assert.equal(sinks.length, 1, "exactly one spill sink opened");
  const sink = sinks[0];
  assert.ok(sink);
  assert.equal(sink.bytes, 3000, "every byte streamed through the sink intact");
  assert.equal(sink.finished, true);
  assert.equal(sink.aborted, false);

  assert.equal(sqs.sent.length, 1);
  const sent = sqs.sent[0];
  assert.ok(sent);
  const msg = JSON.parse(sent);
  assert.equal(msg.body.storage, "s3");
  assert.equal(msg.body.bucket, "test-bucket");
  assert.equal(msg.body.sizeBytes, 3000);
  assert.match(msg.body.key, /^otlp-oversize\/\d{4}\/\d{2}\/\d{2}\/.+\.otlp$/);
});

test("a body over maxBodyBytes is rejected with PayloadTooLargeError and enqueues nothing", async () => {
  // maxBodyBytes (2500) is below the inline threshold (~2232 from maxMessageBytes
  // 4000), so the cap trips while still buffering. The spill-then-abort path is
  // covered separately by the body-capture unit test; here we assert the invariant
  // that an over-cap body never reaches the queue.
  const { queue, sqs } = buildQueue({ maxBodyBytes: 2500 });
  await assert.rejects(
    queue.enqueueStream({
      path: "/v1/traces",
      projectId: "proj-1",
      contentType: "application/x-protobuf",
      body: streamOf("Y".repeat(1500), "Y".repeat(1500)), // 3000 > 2500
    }),
    PayloadTooLargeError,
  );
  assert.equal(sqs.sent.length, 0, "over-cap body must never reach the queue");
});
