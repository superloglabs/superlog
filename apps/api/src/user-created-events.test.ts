import assert from "node:assert/strict";
import test from "node:test";
import { USER_CREATED_QUEUE, publishUserCreated } from "./user-created-events.js";

test("publishes one delayed user-created event per signup", async () => {
  const sent: unknown[] = [];
  const queue = {
    async createQueue(name: string, options?: unknown) {
      sent.push({ createQueue: name, options });
    },
    async send(name: string, data: object, options?: object) {
      sent.push({ send: name, data, options });
      return "job-1";
    },
  };

  await publishUserCreated(queue, {
    id: "user-1",
    email: "dev@example.com",
    name: "Dev",
    createdAt: new Date("2026-07-22T12:00:00Z"),
  });

  assert.deepEqual(sent, [
    { createQueue: USER_CREATED_QUEUE, options: { policy: "standard" } },
    {
      send: USER_CREATED_QUEUE,
      data: {
        userId: "user-1",
        email: "dev@example.com",
        name: "Dev",
        createdAt: "2026-07-22T12:00:00.000Z",
      },
      options: { id: "user-1", startAfter: 300, retryLimit: 3, retryBackoff: true },
    },
  ]);
});
