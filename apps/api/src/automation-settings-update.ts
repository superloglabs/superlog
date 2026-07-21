export type AutomationSettingsUpdateValues = {
  autoInvestigateIssuesEnabled: boolean;
  agentRunProvider: string;
  maxRuntimeMinutes: number;
  maxHumanResumeCount: number;
  customInstructions: string;
  agentRunEnabled: boolean;
  chatEnabled: boolean;
  linearTicketPolicy: string;
  linearTicketInstructions: unknown[];
  prPolicy: string;
  approvalPromptsEnabled: boolean;
  createLinearTicketOnResolve: boolean;
  autoResolveStaleIncidentsEnabled: boolean;
  prBaseBranch: string | null;
  autoMergeFixPrs: string;
  autoMergeMethod: string;
  issueFilterConfig: unknown;
};

const AGENT_POLICIES = new Set(["never", "on_ready_to_pr", "always"]);
const AUTO_MERGE_POLICIES = new Set(["never", "when_checks_pass", "immediately"]);
const AUTO_MERGE_METHODS = new Set(["squash", "merge", "rebase"]);

export function buildAutomationSettingsConflictUpdate<T extends AutomationSettingsUpdateValues>(
  body: Record<string, unknown>,
  values: T,
  updatedAt: Date,
): Partial<T> & { updatedAt: Date } {
  return {
    ...(typeof body.autoInvestigateIssuesEnabled === "boolean"
      ? { autoInvestigateIssuesEnabled: values.autoInvestigateIssuesEnabled }
      : {}),
    ...(typeof body.agentRunProvider === "string"
      ? { agentRunProvider: values.agentRunProvider }
      : {}),
    ...(typeof body.maxRuntimeMinutes === "number"
      ? { maxRuntimeMinutes: values.maxRuntimeMinutes }
      : {}),
    ...(typeof body.maxHumanResumeCount === "number"
      ? { maxHumanResumeCount: values.maxHumanResumeCount }
      : {}),
    ...(typeof body.customInstructions === "string"
      ? { customInstructions: values.customInstructions }
      : {}),
    ...(typeof body.agentRunEnabled === "boolean"
      ? { agentRunEnabled: values.agentRunEnabled }
      : {}),
    ...(typeof body.chatEnabled === "boolean" ? { chatEnabled: values.chatEnabled } : {}),
    ...(typeof body.linearTicketPolicy === "string" && AGENT_POLICIES.has(body.linearTicketPolicy)
      ? { linearTicketPolicy: values.linearTicketPolicy }
      : {}),
    ...(Array.isArray(body.linearTicketInstructions)
      ? { linearTicketInstructions: values.linearTicketInstructions }
      : {}),
    ...(typeof body.prPolicy === "string" && AGENT_POLICIES.has(body.prPolicy)
      ? { prPolicy: values.prPolicy }
      : {}),
    ...(typeof body.approvalPromptsEnabled === "boolean"
      ? { approvalPromptsEnabled: values.approvalPromptsEnabled }
      : {}),
    ...(typeof body.createLinearTicketOnResolve === "boolean"
      ? { createLinearTicketOnResolve: values.createLinearTicketOnResolve }
      : {}),
    ...(typeof body.autoResolveStaleIncidentsEnabled === "boolean"
      ? { autoResolveStaleIncidentsEnabled: values.autoResolveStaleIncidentsEnabled }
      : {}),
    ...(body.prBaseBranch !== undefined ? { prBaseBranch: values.prBaseBranch } : {}),
    ...(typeof body.autoMergeFixPrs === "string" && AUTO_MERGE_POLICIES.has(body.autoMergeFixPrs)
      ? { autoMergeFixPrs: values.autoMergeFixPrs }
      : {}),
    ...(typeof body.autoMergeMethod === "string" && AUTO_MERGE_METHODS.has(body.autoMergeMethod)
      ? { autoMergeMethod: values.autoMergeMethod }
      : {}),
    ...(body.issueFilterConfig !== undefined
      ? { issueFilterConfig: values.issueFilterConfig }
      : {}),
    updatedAt,
  } as Partial<T> & { updatedAt: Date };
}
