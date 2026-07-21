import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRecoveryClaimReclaimable,
  reclaimStaleRecoveryClaim,
  recoverExhaustedRunnerTurn,
} from "./recovery.js";

test("only abandoned recovery claims are reclaimable", () => {
  const now = new Date("2026-07-21T19:00:00.000Z");

  assert.equal(
    isRecoveryClaimReclaimable({
      createdAt: new Date("2026-07-21T18:57:00.000Z"),
      processedAt: null,
      now,
    }),
    true,
  );
  assert.equal(
    isRecoveryClaimReclaimable({
      createdAt: new Date("2026-07-21T18:59:00.000Z"),
      processedAt: null,
      now,
    }),
    false,
  );
  assert.equal(
    isRecoveryClaimReclaimable({
      createdAt: new Date("2026-07-21T18:55:00.000Z"),
      processedAt: new Date("2026-07-21T18:55:10.000Z"),
      now,
    }),
    false,
  );
});

test("a claim completed during stale reclamation is not deleted or replaced", async () => {
  let replacementAttempts = 0;

  const claim = await reclaimStaleRecoveryClaim({
    staleClaim: {
      id: "recovery-claim-1",
      createdAt: new Date("2026-07-21T18:55:00.000Z"),
      processedAt: null,
    },
    now: new Date("2026-07-21T19:00:00.000Z"),
    async deleteIfStillUnprocessed() {
      // The original owner completed the claim after it was read.
      return false;
    },
    async insertReplacement() {
      replacementAttempts += 1;
      return { id: "recovery-claim-2" };
    },
  });

  assert.equal(claim, null);
  assert.equal(replacementAttempts, 0);
});

test("an exhausted turn refreshes authorized repositories and continues its existing session", async () => {
  const recovered: Array<{
    sessionId: string;
    message: string;
    tokens: string[];
  }> = [];
  const completedClaims: string[] = [];

  const outcome = await recoverExhaustedRunnerTurn({
    sessionId: "session-1",
    failure: {
      kind: "provider_retries_exhausted",
      providerEventId: "sevt-capacity",
    },
    runner: {
      async recover(sessionId, input) {
        recovered.push({
          sessionId,
          message: input.continuationMessage,
          tokens: [
            await input.authorizeRepository("acme/api"),
            await input.authorizeRepository("acme/web"),
          ],
        });
      },
    },
    async listRepositories() {
      return [
        { fullName: "acme/api", id: 11, installationId: 101 },
        { fullName: "acme/web", id: 12, installationId: 102 },
      ];
    },
    async createRepositoryReadToken(installationId, repositoryId) {
      return `token-${installationId}-${repositoryId}`;
    },
    async claimRecovery() {
      return { id: "recovery-claim-1" };
    },
    async releaseRecoveryClaim() {},
    async completeRecoveryClaim(id) {
      completedClaims.push(id);
    },
  });

  assert.equal(outcome, "recovered");
  assert.deepEqual(recovered, [
    {
      sessionId: "session-1",
      message:
        "[SUPERLOG_SESSION_RECOVERY sevt-capacity]\nThe previous turn ended because the managed service exhausted its retries. Repository credentials have been refreshed. Continue the existing investigation from its current context. First verify that the mounted repositories are available, then finish the investigation and use the appropriate terminal outcome tool.",
      tokens: ["token-101-11", "token-102-12"],
    },
  ]);
  assert.deepEqual(completedClaims, ["recovery-claim-1"]);
});

test("a concurrent sync pass does not recover the same exhausted turn twice", async () => {
  let recoverCalls = 0;

  const outcome = await recoverExhaustedRunnerTurn({
    sessionId: "session-1",
    failure: {
      kind: "provider_retries_exhausted",
      providerEventId: "sevt-capacity",
    },
    runner: {
      async recover() {
        recoverCalls += 1;
      },
    },
    async listRepositories() {
      return [];
    },
    async createRepositoryReadToken() {
      return "token";
    },
    async claimRecovery() {
      return null;
    },
    async releaseRecoveryClaim() {},
    async completeRecoveryClaim() {},
  });

  assert.equal(outcome, "already_claimed");
  assert.equal(recoverCalls, 0);
});

test("a failed credential refresh releases the recovery claim for a later sync pass", async () => {
  const released: string[] = [];

  await assert.rejects(
    recoverExhaustedRunnerTurn({
      sessionId: "session-1",
      failure: {
        kind: "provider_retries_exhausted",
        providerEventId: "sevt-capacity",
      },
      runner: {
        async recover(_sessionId, input) {
          await input.authorizeRepository("acme/api");
        },
      },
      async listRepositories() {
        return [{ fullName: "acme/api", id: 11, installationId: 101 }];
      },
      async createRepositoryReadToken() {
        throw new Error("GitHub temporarily unavailable");
      },
      async claimRecovery() {
        return { id: "recovery-claim-1" };
      },
      async releaseRecoveryClaim(id) {
        released.push(id);
      },
      async completeRecoveryClaim() {},
    }),
    /GitHub temporarily unavailable/,
  );

  assert.deepEqual(released, ["recovery-claim-1"]);
});
