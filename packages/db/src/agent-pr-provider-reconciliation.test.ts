import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileAgentPullRequestProviderObservation } from "./agent-pr-provider-reconciliation.js";

const PROVIDER_UPDATED_AT = new Date("2026-07-15T10:00:01.000Z");

test("an equal-timestamp stale close yields to the authoritative open provider state", async () => {
  const appliedStates: Array<{ state: string | undefined; authoritative: boolean }> = [];
  const result = await reconcileAgentPullRequestProviderObservation(
    {
      targetState: "closed",
      observedAt: new Date("2026-07-15T10:05:01.000Z"),
      providerUpdatedAt: PROVIDER_UPDATED_AT,
      closedAt: PROVIDER_UPDATED_AT,
    },
    {
      async applyObservation(observation) {
        appliedStates.push({
          state: observation.targetState,
          authoritative: observation.providerSnapshotAuthoritative === true,
        });
        return observation.providerSnapshotAuthoritative
          ? {
              pullRequestState: "open" as const,
              stateChanged: false,
              providerReconciliationRequired: false,
            }
          : {
              pullRequestState: "open" as const,
              stateChanged: false,
              providerReconciliationRequired: true,
            };
      },
      async loadAuthoritativeObservation() {
        return {
          targetState: "open" as const,
          observedAt: new Date("2026-07-15T10:05:02.000Z"),
          providerUpdatedAt: PROVIDER_UPDATED_AT,
          closedAt: null,
        };
      },
    },
  );

  assert.deepEqual(appliedStates, [
    { state: "closed", authoritative: false },
    { state: "open", authoritative: true },
  ]);
  assert.equal(result.appliedObservation.targetState, "open");
  assert.equal(result.mutation.pullRequestState, "open");
});

test("an equal-timestamp stale reopen yields to the authoritative closed provider state", async () => {
  const appliedStates: Array<{ state: string | undefined; authoritative: boolean }> = [];
  const result = await reconcileAgentPullRequestProviderObservation(
    {
      targetState: "open",
      observedAt: new Date("2026-07-15T10:05:01.000Z"),
      providerUpdatedAt: PROVIDER_UPDATED_AT,
      closedAt: null,
    },
    {
      async applyObservation(observation) {
        appliedStates.push({
          state: observation.targetState,
          authoritative: observation.providerSnapshotAuthoritative === true,
        });
        return observation.providerSnapshotAuthoritative
          ? {
              pullRequestState: "closed" as const,
              stateChanged: false,
              providerReconciliationRequired: false,
            }
          : {
              pullRequestState: "closed" as const,
              stateChanged: false,
              providerReconciliationRequired: true,
            };
      },
      async loadAuthoritativeObservation() {
        return {
          targetState: "closed" as const,
          observedAt: new Date("2026-07-15T10:05:02.000Z"),
          providerUpdatedAt: PROVIDER_UPDATED_AT,
          closedAt: PROVIDER_UPDATED_AT,
        };
      },
    },
  );

  assert.deepEqual(appliedStates, [
    { state: "open", authoritative: false },
    { state: "closed", authoritative: true },
  ]);
  assert.equal(result.appliedObservation.targetState, "closed");
  assert.equal(result.mutation.pullRequestState, "closed");
});

test("an unwatermarked reversible mutation reads authority before changing canonical state", async () => {
  const appliedStates: Array<{ state: string | undefined; authoritative: boolean }> = [];
  let authoritativeReadCount = 0;
  const result = await reconcileAgentPullRequestProviderObservation(
    {
      targetState: "closed",
      observedAt: new Date("2026-07-15T10:05:01.000Z"),
      closedAt: new Date("2026-07-15T10:05:01.000Z"),
    },
    {
      async applyObservation(observation) {
        appliedStates.push({
          state: observation.targetState,
          authoritative: observation.providerSnapshotAuthoritative === true,
        });
        return {
          pullRequestState: observation.targetState ?? null,
          stateChanged: true,
          providerReconciliationRequired: false,
        };
      },
      async loadAuthoritativeObservation() {
        authoritativeReadCount += 1;
        return {
          targetState: "open" as const,
          observedAt: new Date("2026-07-15T10:05:02.000Z"),
          providerUpdatedAt: PROVIDER_UPDATED_AT,
          closedAt: null,
        };
      },
    },
  );

  assert.equal(authoritativeReadCount, 1);
  assert.deepEqual(appliedStates, [{ state: "open", authoritative: true }]);
  assert.equal(result.mutation.pullRequestState, "open");
});
