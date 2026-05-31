import assert from "node:assert/strict";
import { test } from "node:test";
import { syncAttio } from "./sync.js";
import type { AttioClient, AttioRepository } from "./sync.js";

test("syncAttio upserts people before writing company teams with person record ids", async () => {
  const calls: string[] = [];
  const repository: AttioRepository = {
    async loadOrgSnapshots() {
      return [
        {
          id: "org-1",
          name: "Acme",
          slug: "acme",
          createdAt: "2026-05-01T00:00:00Z",
          memberCount: 1,
          projectCount: 1,
          ownerEmail: "ada@acme.com",
          memberEmails: ["ada@acme.com"],
          githubConnected: false,
          slackConnected: false,
          mcpConnected: false,
          prsOpenedLastWeek: 0,
          prsMergedLastWeek: 0,
          projectIds: ["project-1"],
        },
      ];
    },
    async loadUserSnapshots() {
      return [
        {
          id: "user-1",
          email: "ada@acme.com",
          name: "Ada",
          createdAt: "2026-05-01T00:00:00Z",
          memberships: [{ orgId: "org-1", orgName: "Acme", role: "owner" }],
        },
      ];
    },
    async loadTraceMetricsByOrgId() {
      return new Map();
    },
  };
  const client: AttioClient = {
    async listCompanyRecordsBySuperlogOrgId() {
      calls.push("list-companies");
      return new Map();
    },
    async createRecord() {
      calls.push("create-company");
      return { recordId: "company-1" };
    },
    async updateRecordOverwrite() {
      calls.push("update-company");
    },
    async upsertRecord(object) {
      calls.push(`upsert-${object}`);
      return { recordId: "person-1" };
    },
  };

  const result = await syncAttio({ repository, client });

  assert.equal(result.errors.length, 0);
  assert.equal(result.companiesCreated, 1);
  assert.equal(result.peopleUpserted, 1);
  assert.equal(result.companyTeamsUpdated, 1);
  assert.deepEqual(calls, ["list-companies", "create-company", "upsert-people", "update-company"]);
});
