// Bootstrap: @superlog/db throws at import time when DATABASE_URL is unset.
// These tests use a mock DB and never connect.
import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { DB } from "@superlog/db";
import { schema } from "@superlog/db";
import { attemptDelivery } from "./webhooks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

/** Minimal chainable drizzle-update mock that captures the last .set() call. */
function makeDb() {
  const updates: { values: Record<string, unknown> }[] = [];
  const db = {
    update(_table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(_cond: unknown) {
              updates.push({ values });
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as DB;
  return { db, updates };
}

function makeEndpoint(port: number): schema.WebhookEndpoint {
  return {
    id: "ep-1",
    projectId: "proj-1",
    url: `http://127.0.0.1:${port}/hook`,
    secret: "test-secret",
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    eventTypes: [],
  } as unknown as schema.WebhookEndpoint;
}

function makeDelivery(overrides?: Partial<schema.WebhookDelivery>): schema.WebhookDelivery {
  return {
    id: "del-1",
    endpointId: "ep-1",
    projectId: "proj-1",
    eventType: "incident.created",
    payload: { hello: "world" },
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date(),
    lastAttemptAt: null,
    lastResponseStatus: null,
    lastResponseBody: null,
    lastError: null,
    deliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as schema.WebhookDelivery;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// These tests hit a local server, so they need the escape hatch.
const origAllow = process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS;
before(() => {
  process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "1";
});
after(() => {
  process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = origAllow ?? "";
});

describe("attemptDelivery", () => {
  it("marks delivery successful on 2xx and records no error", async () => {
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 201;
      res.end();
    });

    try {
      const { db, updates } = makeDb();
      await attemptDelivery(makeEndpoint(port), makeDelivery(), db);
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.values.status, "success");
      assert.equal(updates[0]?.values.lastResponseStatus, 201);
      assert.equal(updates[0]?.values.lastError, null);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("marks delivery pending (retry) on non-2xx and records the status", async () => {
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 502;
      res.end("bad gateway");
    });

    try {
      const { db, updates } = makeDb();
      await attemptDelivery(makeEndpoint(port), makeDelivery(), db);
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.values.status, "pending");
      assert.equal(updates[0]?.values.lastResponseStatus, 502);
      assert.equal(updates[0]?.values.lastError, null);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("marks delivery pending on 4xx", async () => {
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });

    try {
      const { db, updates } = makeDb();
      await attemptDelivery(makeEndpoint(port), makeDelivery(), db);
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.values.status, "pending");
      assert.equal(updates[0]?.values.lastResponseStatus, 404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("records a network error message when the server is unreachable", async () => {
    const { db, updates } = makeDb();
    // Port 1 is never open; connection should fail fast.
    const endpoint = makeEndpoint(1);
    await attemptDelivery(endpoint, makeDelivery(), db);
    assert.equal(updates.length, 1);
    // Status stays null (no HTTP response), error message populated.
    assert.equal(updates[0]?.values.lastResponseStatus, null);
    assert.ok(
      typeof updates[0]?.values.lastError === "string" &&
        (updates[0].values.lastError as string).length > 0,
      "lastError should be a non-empty string",
    );
  });

  it("exhausts retries and marks delivery failed after MAX_ATTEMPTS", async () => {
    // Simulate a delivery that is on its last allowed attempt.
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 503;
      res.end();
    });

    try {
      const { db, updates } = makeDb();
      // attemptCount=7 means this is the 8th attempt (MAX_ATTEMPTS=8).
      await attemptDelivery(makeEndpoint(port), makeDelivery({ attemptCount: 7 }), db);
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.values.status, "failed");
      assert.equal(updates[0]?.values.lastResponseStatus, 503);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does not emit an unhandledRejection on a large non-2xx response body", async () => {
    // This test guards against "Response object has been garbage collected".
    // We send a large body (> 64 KiB) so undici must stream it; if body.cancel()
    // were absent the stream would stay open until GC ran — this test verifies
    // that the promise chain resolves cleanly without any unhandled rejection.
    const largeBody = "x".repeat(128 * 1024); // 128 KiB
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 500;
      res.end(largeBody);
    });

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const { db, updates } = makeDb();
      await attemptDelivery(makeEndpoint(port), makeDelivery(), db);

      // Allow pending microtasks and macrotasks to settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.values.status, "pending");
      assert.equal(
        rejections.length,
        0,
        `unhandledRejection should not fire; got: ${rejections.map(String).join(", ")}`,
      );
    } finally {
      process.off("unhandledRejection", onRejection);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
