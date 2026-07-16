import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enqueueObservabilityReview,
  observabilityReviewCommandFromWebhook,
} from "./pr-observability-review.js";

const payload = {
  action: "opened",
  installation: { id: 123 },
  repository: { id: 456, full_name: "acme/shop" },
  pull_request: {
    number: 42,
    draft: false,
    head: { sha: "abc123" },
  },
};

test("an opened non-draft pull request produces an observability review command", () => {
  assert.deepEqual(observabilityReviewCommandFromWebhook("pull_request", payload), {
    installationId: 123,
    repoId: 456,
    repoFullName: "acme/shop",
    prNumber: 42,
    headSha: "abc123",
  });
});

test("new commits and ready-for-review transitions request a fresh review", () => {
  for (const action of ["synchronize", "reopened", "ready_for_review"]) {
    assert.ok(
      observabilityReviewCommandFromWebhook("pull_request", {
        ...payload,
        action,
      }),
    );
  }
});

test("draft and unrelated pull request events do not request a review", () => {
  assert.equal(
    observabilityReviewCommandFromWebhook("pull_request", {
      ...payload,
      pull_request: { ...payload.pull_request, draft: true },
    }),
    null,
  );
  assert.equal(
    observabilityReviewCommandFromWebhook("pull_request", { ...payload, action: "closed" }),
    null,
  );
  assert.equal(observabilityReviewCommandFromWebhook("push", payload), null);
});

test("review enqueue is opt-in and persists the owning scope", async () => {
  const command = observabilityReviewCommandFromWebhook("pull_request", payload);
  assert.ok(command);
  const inserted: unknown[] = [];

  assert.equal(
    await enqueueObservabilityReview(command, {
      findEnabledScope: async () => null,
      insert: async (input) => {
        inserted.push(input);
      },
    }),
    false,
  );
  assert.equal(
    await enqueueObservabilityReview(command, {
      findEnabledScope: async () => ({ orgId: "org-1", projectId: "project-1" }),
      insert: async (input) => {
        inserted.push(input);
      },
    }),
    true,
  );
  assert.deepEqual(inserted, [
    {
      ...command,
      orgId: "org-1",
      projectId: "project-1",
    },
  ]);
});
