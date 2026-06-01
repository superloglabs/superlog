import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Semaphore } from "./semaphore.js";

test("acquires up to the permit count without waiting, then queues", async () => {
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();
  assert.equal(sem.availablePermits, 0);

  let third = "pending";
  const pending = sem.acquire().then(() => {
    third = "acquired";
  });
  await Promise.resolve();
  assert.equal(third, "pending");
  assert.equal(sem.queueLength, 1);

  sem.release();
  await pending;
  assert.equal(third, "acquired");
  assert.equal(sem.queueLength, 0);
});

test("releases hand permits to waiters in FIFO order", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  const order: number[] = [];
  const a = sem.acquire().then(() => order.push(1));
  const b = sem.acquire().then(() => order.push(2));
  await Promise.resolve();
  assert.equal(sem.queueLength, 2);

  sem.release();
  await a;
  sem.release();
  await b;
  assert.deepEqual(order, [1, 2]);
});

test("releasing with no waiters restores a permit", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();
  assert.equal(sem.availablePermits, 0);
  sem.release();
  assert.equal(sem.availablePermits, 1);
  // A surplus release does not exceed... it just tracks available; next acquire is immediate.
  await sem.acquire();
  assert.equal(sem.availablePermits, 0);
});

test("a permit count of zero disables limiting (always immediate, never queues)", async () => {
  const sem = new Semaphore(0);
  await sem.acquire();
  await sem.acquire();
  await sem.acquire();
  assert.equal(sem.queueLength, 0);
  sem.release(); // no-op, must not throw
});
