import { strict as assert } from "node:assert";
import { test } from "node:test";
import { startGcpAuthorization } from "./authorization-application.js";
import {
  GCP_AUTHORIZATION_TTL_MS,
  type GcpAuthorizationRepository,
  type GcpAuthorizationSessionRecord,
  type GcpGateway,
} from "./domain.js";

test("a pending Google authorization and its signed state share one lifetime", async () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  let createCalled = false;
  const repository = {
    async create(input: { projectId: string; userId: string; expiresAt: Date }) {
      createCalled = true;
      assert.equal(input.expiresAt.getTime(), now.getTime() + GCP_AUTHORIZATION_TTL_MS);
      return {
        id: "authorization-id",
        ...input,
        status: "pending",
        projects: [],
        consumedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      } satisfies GcpAuthorizationSessionRecord;
    },
  } as unknown as GcpAuthorizationRepository;
  const gateway = {
    authorizationUrl: ({ state }: { state: string }) => `https://example.com/oauth?state=${state}`,
  } as GcpGateway;

  await startGcpAuthorization({
    projectId: "project-id",
    userId: "user-id",
    repository,
    gateway,
    signState: () => "signed-state",
    now,
  });

  assert.equal(createCalled, true);
});
