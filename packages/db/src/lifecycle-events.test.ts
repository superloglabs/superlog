import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type LifecycleEvent,
  type LifecycleEventSink,
  emitLifecycleEvent,
  registerLifecycleEventSink,
  resetLifecycleEventSink,
} from "./lifecycle-events.js";

test.afterEach(() => {
  resetLifecycleEventSink();
});

function recordingSink(): { sink: LifecycleEventSink; calls: LifecycleEvent[] } {
  const calls: LifecycleEvent[] = [];
  return {
    calls,
    sink: {
      record(e) {
        calls.push(e);
      },
    },
  };
}

test("default sink is a no-op and emit never throws", async () => {
  await assert.doesNotReject(
    emitLifecycleEvent({ event: "signup", userId: "u1", email: "a@b.com" }),
  );
});

test("registerLifecycleEventSink installs a sink emit delegates to", async () => {
  const { sink, calls } = recordingSink();
  registerLifecycleEventSink(sink);
  await emitLifecycleEvent({
    event: "signup",
    userId: "u1",
    email: "a@b.com",
    dedupeId: "signup-u1",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    event: "signup",
    userId: "u1",
    email: "a@b.com",
    dedupeId: "signup-u1",
  });
});

test("registering a sink replaces the previous one", async () => {
  const first = recordingSink();
  const second = recordingSink();
  registerLifecycleEventSink(first.sink);
  registerLifecycleEventSink(second.sink);
  await emitLifecycleEvent({ event: "first_telemetry", userId: "u1" });
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);
});

test("resetLifecycleEventSink restores the no-op sink", async () => {
  const { sink, calls } = recordingSink();
  registerLifecycleEventSink(sink);
  resetLifecycleEventSink();
  await emitLifecycleEvent({ event: "signup", userId: "u1" });
  assert.equal(calls.length, 0);
});

test("emit supports async sinks and swallows delivery failures", async () => {
  registerLifecycleEventSink({
    async record() {
      throw new Error("network down");
    },
  });
  await assert.doesNotReject(
    emitLifecycleEvent({ event: "first_telemetry", userId: "u1", email: "a@b.com" }),
  );
});
