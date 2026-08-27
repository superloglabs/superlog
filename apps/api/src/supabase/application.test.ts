import { strict as assert } from "node:assert";
import test from "node:test";
import {
  type SupabaseConnectionRepository,
  type SupabaseGateway,
  type SupabaseGrantRepository,
  completeSupabaseOAuth,
  connectSupabaseProjects,
} from "./application.js";

test("one Supabase grant can connect multiple projects with independent environments", async () => {
  const saved: Array<{ projectRef: string; environment: string }> = [];
  const repository: SupabaseConnectionRepository = {
    async findGrant(orgId, grantId) {
      assert.equal(orgId, "org-1");
      assert.equal(grantId, "grant-1");
      return { id: grantId, orgId, revokedAt: null };
    },
    async upsertConnections(input) {
      saved.push(...input.connections);
      return input.connections.map((connection, index) => ({
        id: `connection-${index + 1}`,
        ...connection,
      }));
    },
  };
  const gateway: SupabaseGateway = {
    async listProjects(grantId) {
      assert.equal(grantId, "grant-1");
      return [
        {
          ref: "abcdefghijklmnopqrst",
          name: "Acme production",
          organizationSlug: "acme",
          region: "eu-west-1",
        },
        {
          ref: "zyxwvutsrqponmlkjihg",
          name: "Acme staging",
          organizationSlug: "acme",
          region: "eu-west-1",
        },
      ];
    },
  };

  const connections = await connectSupabaseProjects({
    orgId: "org-1",
    projectId: "superlog-project-1",
    grantId: "grant-1",
    actorUserId: "user-1",
    selections: [
      { projectRef: "abcdefghijklmnopqrst", environment: "production" },
      { projectRef: "zyxwvutsrqponmlkjihg", environment: "staging" },
    ],
    repository,
    gateway,
  });

  assert.equal(connections.length, 2);
  assert.deepEqual(saved, [
    {
      projectRef: "abcdefghijklmnopqrst",
      projectName: "Acme production",
      organizationSlug: "acme",
      region: "eu-west-1",
      environment: "production",
    },
    {
      projectRef: "zyxwvutsrqponmlkjihg",
      projectName: "Acme staging",
      organizationSlug: "acme",
      region: "eu-west-1",
      environment: "staging",
    },
  ]);
});

test("a Supabase project connection requires a non-empty environment", async () => {
  const repository: SupabaseConnectionRepository = {
    async findGrant() {
      return { id: "grant-1", orgId: "org-1", revokedAt: null };
    },
    async upsertConnections() {
      throw new Error("invalid connections must not be persisted");
    },
  };
  const gateway: SupabaseGateway = {
    async listProjects() {
      return [
        {
          ref: "abcdefghijklmnopqrst",
          name: "Acme production",
          organizationSlug: "acme",
          region: "eu-west-1",
        },
      ];
    },
  };

  await assert.rejects(
    connectSupabaseProjects({
      orgId: "org-1",
      projectId: "superlog-project-1",
      grantId: "grant-1",
      actorUserId: "user-1",
      selections: [{ projectRef: "abcdefghijklmnopqrst", environment: "   " }],
      repository,
      gateway,
    }),
    /environment/i,
  );
});

test("project selection rejects empty and duplicate batches", async () => {
  const repository: SupabaseConnectionRepository = {
    async findGrant() {
      return { id: "grant-1", orgId: "org-1", revokedAt: null };
    },
    async upsertConnections() {
      throw new Error("invalid connections must not be persisted");
    },
  };
  const gateway: SupabaseGateway = {
    async listProjects() {
      return [
        {
          ref: "abcdefghijklmnopqrst",
          name: "Acme production",
          organizationSlug: "acme",
          region: "eu-west-1",
        },
      ];
    },
  };
  const base = {
    orgId: "org-1",
    projectId: "superlog-project-1",
    grantId: "grant-1",
    actorUserId: "user-1",
    repository,
    gateway,
  };

  await assert.rejects(connectSupabaseProjects({ ...base, selections: [] }), /at least one/i);
  await assert.rejects(
    connectSupabaseProjects({
      ...base,
      selections: [
        { projectRef: "abcdefghijklmnopqrst", environment: "production" },
        { projectRef: "abcdefghijklmnopqrst", environment: "staging" },
      ],
    }),
    /duplicate/i,
  );
});

test("OAuth completion stores one reusable grant for the Supabase account", async () => {
  let persisted: Parameters<SupabaseGrantRepository["upsertGrant"]>[0] | null = null;
  const repository: SupabaseGrantRepository = {
    async upsertGrant(input) {
      persisted = input;
      return { id: "grant-1", orgId: input.orgId, revokedAt: null };
    },
  };

  const grant = await completeSupabaseOAuth({
    orgId: "org-1",
    actorUserId: "user-1",
    code: "authorization-code",
    repository,
    gateway: {
      async exchangeCode(code) {
        assert.equal(code, "authorization-code");
        return {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresInSeconds: 3600,
        };
      },
      async getProfile(accessToken) {
        assert.equal(accessToken, "access-token");
        return {
          userId: "supabase-user-1",
          primaryEmail: "owner@example.com",
          username: "Owner",
        };
      },
    },
    now: new Date("2026-08-27T12:00:00.000Z"),
  });

  assert.equal(grant.id, "grant-1");
  assert.deepEqual(persisted, {
    orgId: "org-1",
    actorUserId: "user-1",
    supabaseUserId: "supabase-user-1",
    primaryEmail: "owner@example.com",
    username: "Owner",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiresAt: new Date("2026-08-27T13:00:00.000Z"),
  });
});
