import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAttioSyncPlan, buildPersonName } from "./domain.js";

test("plans company creates, company analytics updates, people upserts, and exact team updates", () => {
  const plan = buildAttioSyncPlan({
    orgs: [
      {
        id: "org-1",
        name: "Acme",
        slug: "acme",
        createdAt: "2026-05-01T00:00:00Z",
        memberCount: 2,
        projectCount: 1,
        ownerEmail: "owner@acme.com",
        memberEmails: ["owner@acme.com", "multi@example.com"],
        githubConnected: true,
        slackConnected: false,
        mcpConnected: true,
        prsOpenedLastWeek: 4,
        prsMergedLastWeek: 2,
        projectIds: ["project-1"],
      },
      {
        id: "org-2",
        name: "Beta",
        slug: "beta",
        createdAt: "2026-05-02T00:00:00Z",
        memberCount: 1,
        projectCount: 1,
        ownerEmail: "multi@example.com",
        memberEmails: ["multi@example.com"],
        githubConnected: false,
        slackConnected: true,
        mcpConnected: false,
        prsOpenedLastWeek: 1,
        prsMergedLastWeek: 0,
        projectIds: ["project-2"],
      },
    ],
    users: [
      {
        id: "user-1",
        email: "Owner@Acme.com",
        name: "Ada Owner",
        createdAt: "2026-05-01T00:00:00Z",
        memberships: [{ orgId: "org-1", orgName: "Acme", role: "owner" }],
      },
      {
        id: "user-2",
        email: "multi@example.com",
        name: "Multi User",
        createdAt: "2026-05-02T00:00:00Z",
        memberships: [
          { orgId: "org-1", orgName: "Acme", role: "member" },
          { orgId: "org-2", orgName: "Beta", role: "owner" },
        ],
      },
    ],
    companyRecordsByOrgId: new Map([["org-1", "company-1"]]),
    tracesByOrgId: new Map([["org-1", { tracesLastWeek: 42, spanRowsLastWeek: 100 }]]),
  });

  assert.equal(plan.companyUpdates.length, 1);
  assert.deepEqual(plan.companyUpdates[0]?.values, {
    superlog_org_id: "org-1",
    superlog_org_name: "Acme",
    github_connected: true,
    slack_connected: false,
    traces_last_week: 42,
    prs_opened_last_week: "4",
    prs_merged_last_week: 2,
  });
  assert.equal(plan.companyCreates.length, 1);
  assert.equal(plan.companyCreates[0]?.values.name, "Beta");
  assert.equal(plan.peopleUpserts.length, 2);
  assert.match(String(plan.peopleUpserts[1]?.values.description), /Beta \(owner\) \[org-2\]/);
  assert.deepEqual(plan.companyTeamUpdates, [
    {
      object: "companies",
      recordId: "company-1",
      orgId: "org-1",
      memberEmails: ["owner@acme.com"],
    },
  ]);
  assert.deepEqual(plan.totals, {
    orgs: 2,
    companyUpdates: 1,
    companyCreates: 1,
    peopleUpserts: 2,
    companyTeamUpdates: 1,
    memberships: 3,
    unambiguousTeamMemberships: 1,
    githubConnected: 1,
    slackConnected: 1,
    withTracesLastWeek: 1,
    prsOpenedLastWeek: 5,
    prsMergedLastWeek: 2,
    mcpConnectedAuditOnly: 1,
  });
});

test("derives Attio personal names from display names or email local parts", () => {
  assert.deepEqual(buildPersonName("Ada Lovelace", "ada@example.com"), {
    first_name: "Ada",
    last_name: "Lovelace",
    full_name: "Ada Lovelace",
  });
  assert.deepEqual(buildPersonName("", "solo@example.com"), {
    first_name: "solo",
    last_name: "",
    full_name: "solo",
  });
});
