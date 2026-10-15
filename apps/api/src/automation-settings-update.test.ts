import assert from "node:assert/strict";
import test from "node:test";
import {
  type AutomationSettingsUpdateValues,
  InvalidLinearDefaultTeamError,
  buildAutomationSettingsConflictUpdate,
  linearDefaultTeamExists,
  parseLinearDefaultTeamId,
} from "./automation-settings-update.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");

function values(
  overrides: Partial<AutomationSettingsUpdateValues> = {},
): AutomationSettingsUpdateValues {
  return {
    autoInvestigateIssuesEnabled: true,
    agentRunProvider: "community",
    maxRuntimeMinutes: 90,
    maxHumanResumeCount: 3,
    customInstructions: "",
    agentRunEnabled: true,
    chatEnabled: true,
    linearTicketPolicy: "on_ready_to_pr",
    linearTicketInstructions: [],
    prPolicy: "on_ready_to_pr",
    approvalPromptsEnabled: true,
    createLinearTicketOnResolve: false,
    linearDefaultTeamId: null,
    autoResolveStaleIncidentsEnabled: true,
    prBaseBranch: null,
    autoMergeFixPrs: "never",
    autoMergeMethod: "squash",
    issueFilterConfig: {},
    ...overrides,
  };
}

test("independent automation PATCHes update only the supplied setting", () => {
  const flowUpdate = buildAutomationSettingsConflictUpdate(
    { agentRunEnabled: false },
    values({ agentRunEnabled: false }),
    NOW,
  );
  const inactivityUpdate = buildAutomationSettingsConflictUpdate(
    { autoResolveStaleIncidentsEnabled: false },
    values({ autoResolveStaleIncidentsEnabled: false }),
    NOW,
  );

  assert.deepEqual(flowUpdate, { agentRunEnabled: false, updatedAt: NOW });
  assert.deepEqual(inactivityUpdate, {
    autoResolveStaleIncidentsEnabled: false,
    updatedAt: NOW,
  });
});

test("a linearDefaultTeamId PATCH writes only the team, including clearing it", () => {
  assert.deepEqual(
    buildAutomationSettingsConflictUpdate(
      { linearDefaultTeamId: "team-engg" },
      values({ linearDefaultTeamId: "team-engg" }),
      NOW,
    ),
    { linearDefaultTeamId: "team-engg", updatedAt: NOW },
  );
  assert.deepEqual(
    buildAutomationSettingsConflictUpdate(
      { linearDefaultTeamId: null },
      values({ linearDefaultTeamId: null }),
      NOW,
    ),
    { linearDefaultTeamId: null, updatedAt: NOW },
  );
});

test("PATCHes that omit linearDefaultTeamId leave the stored team alone", () => {
  const update = buildAutomationSettingsConflictUpdate(
    { chatEnabled: false },
    values({ chatEnabled: false, linearDefaultTeamId: "team-engg" }),
    NOW,
  );
  assert.equal("linearDefaultTeamId" in update, false);
});

test("parseLinearDefaultTeamId keeps, clears, trims, or rejects the input", () => {
  assert.equal(parseLinearDefaultTeamId(undefined, "team-a"), "team-a");
  assert.equal(parseLinearDefaultTeamId(null, "team-a"), null);
  assert.equal(parseLinearDefaultTeamId("   ", "team-a"), null);
  assert.equal(parseLinearDefaultTeamId("  team-b ", "team-a"), "team-b");
  assert.throws(() => parseLinearDefaultTeamId(42, "team-a"), InvalidLinearDefaultTeamError);
  assert.throws(
    () => parseLinearDefaultTeamId("x".repeat(201), null),
    InvalidLinearDefaultTeamError,
  );
});

test("linearDefaultTeamExists matches by id and accepts the workspace fallback", () => {
  const teams = [
    { id: "team-onboard", key: "ONBOARD", name: "Onboarding" },
    { id: "team-engg", key: "ENGG", name: "Engineering" },
  ];
  assert.equal(linearDefaultTeamExists("team-engg", teams), true);
  assert.equal(linearDefaultTeamExists("ENGG", teams), false);
  assert.equal(linearDefaultTeamExists("team-missing", teams), false);
  assert.equal(linearDefaultTeamExists(null, teams), true);
});
