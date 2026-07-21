import assert from "node:assert/strict";
import test from "node:test";
import {
  type AutomationSettingsUpdateValues,
  buildAutomationSettingsConflictUpdate,
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
