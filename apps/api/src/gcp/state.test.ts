import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { test } from "node:test";
import { GCP_AUTHORIZATION_TTL_MS } from "./domain.js";
import { signGcpState, verifyGcpState } from "./state.js";

test("signed Google authorization state expires at the shared authorization lifetime", () => {
  const issuedAt = Date.parse("2026-07-16T12:00:00.000Z");
  const state = signGcpState("authorization-id", "secret", issuedAt);

  assert.ok(verifyGcpState(state, "secret", issuedAt + GCP_AUTHORIZATION_TTL_MS));
  assert.equal(verifyGcpState(state, "secret", issuedAt + GCP_AUTHORIZATION_TTL_MS + 1), null);
});

test("signed Google authorization state binds a disconnect to its original connection", () => {
  const issuedAt = Date.parse("2026-08-21T12:00:00.000Z");
  const state = signGcpState("authorization-id", "secret", issuedAt, {
    action: "disconnect",
    connectionId: "connection-id",
  });

  assert.deepEqual(verifyGcpState(state, "secret", issuedAt), {
    authorizationId: "authorization-id",
    issuedAt,
    action: "disconnect",
    connectionId: "connection-id",
  });
});

test("signed Google authorization state rejects an incomplete disconnect intent", () => {
  const issuedAt = Date.parse("2026-08-21T12:00:00.000Z");
  const body = Buffer.from(
    JSON.stringify({ authorizationId: "authorization-id", issuedAt, action: "disconnect" }),
    "utf8",
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", "secret").update(body).digest("base64url");

  assert.equal(verifyGcpState(`${body}.${signature}`, "secret", issuedAt), null);
});
