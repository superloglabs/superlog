import assert from "node:assert/strict";
import { test } from "node:test";
import { symmetricDecrypt } from "better-auth/crypto";
import { protectBetterAuthToken } from "./auth-credential-storage.js";

const secret = "test-better-auth-secret-with-enough-entropy";

test("plaintext provider tokens are encrypted in Better Auth's native format", async () => {
  const encrypted = await protectBetterAuthToken("provider-token", secret);

  assert.notEqual(encrypted, "provider-token");
  assert.equal(await symmetricDecrypt({ key: secret, data: encrypted }), "provider-token");
});

test("already encrypted provider tokens are left unchanged", async () => {
  const encrypted = await protectBetterAuthToken("provider-token", secret);

  assert.equal(await protectBetterAuthToken(encrypted, secret), encrypted);
});
