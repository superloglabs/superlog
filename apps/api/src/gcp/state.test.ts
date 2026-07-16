import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GCP_AUTHORIZATION_TTL_MS } from "./domain.js";
import { signGcpState, verifyGcpState } from "./state.js";

test("signed Google authorization state expires at the shared authorization lifetime", () => {
  const issuedAt = Date.parse("2026-07-16T12:00:00.000Z");
  const state = signGcpState("authorization-id", "secret", issuedAt);

  assert.ok(verifyGcpState(state, "secret", issuedAt + GCP_AUTHORIZATION_TTL_MS));
  assert.equal(verifyGcpState(state, "secret", issuedAt + GCP_AUTHORIZATION_TTL_MS + 1), null);
});
