import assert from "node:assert/strict";
import test from "node:test";
import { describeIntegrationConnectError } from "./integrationError.ts";

test("503 explains the integration is not configured on the server", () => {
  const msg = describeIntegrationConnectError(
    new Error('503: {"error":"github app not configured"}'),
    "GitHub",
  );
  assert.match(msg, /GitHub isn't configured on this server yet/);
});

test("503 message is integration-specific", () => {
  const msg = describeIntegrationConnectError(new Error("503: {}"), "Slack");
  assert.match(msg, /Slack isn't configured on this server yet/);
});

test("auth failures suggest signing in again", () => {
  for (const status of [401, 403]) {
    const msg = describeIntegrationConnectError(new Error(`${status}: nope`), "GitHub");
    assert.match(msg, /Try signing in again/);
  }
});

test("unknown status surfaces the JSON error detail", () => {
  const msg = describeIntegrationConnectError(new Error('500: {"error":"boom"}'), "GitHub");
  assert.equal(msg, "Couldn't start the GitHub connection: boom");
});

test("non-JSON body is surfaced verbatim", () => {
  const msg = describeIntegrationConnectError(new Error("500: upstream exploded"), "GitHub");
  assert.equal(msg, "Couldn't start the GitHub connection: upstream exploded");
});

test("network error (no status) falls back to a generic retry message", () => {
  const msg = describeIntegrationConnectError(new Error("Failed to fetch"), "GitHub");
  assert.equal(msg, "Couldn't start the GitHub connection: Failed to fetch");
});

test("empty error yields a plain retry message", () => {
  const msg = describeIntegrationConnectError(new Error(""), "GitHub");
  assert.equal(msg, "Couldn't start the GitHub connection. Please try again.");
});

test("non-Error values are coerced safely", () => {
  const msg = describeIntegrationConnectError("503: down", "GitHub");
  assert.match(msg, /isn't configured/);
});
