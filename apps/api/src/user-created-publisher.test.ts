import assert from "node:assert/strict";
import test from "node:test";
import { createUserCreatedPublisher } from "./user-created-publisher.js";

const user = {
  id: "0e3f508d-43e5-4315-b3cf-a829e6410d42",
  email: "dev@example.com",
  createdAt: "2026-07-22T12:00:00.000Z",
};

test("retries queue startup after a transient failure", async () => {
  let starts = 0;
  const sent: unknown[] = [];
  const enqueue = createUserCreatedPublisher({
    enabled: () => true,
    startQueue: async () => {
      starts += 1;
      if (starts === 1) throw new Error("database restarting");
      return {
        createQueue: async () => {},
        send: async (_name, data) => { sent.push(data); },
      };
    },
    onError: () => {},
  });

  assert.equal(await enqueue(user), false);
  assert.equal(await enqueue(user), true);
  assert.equal(starts, 2);
  assert.equal(sent.length, 1);
});
