import type { IncidentEvent } from "../api.ts";
import { type MemoryActivity, memoryActivityFromTool } from "./memory-tool-activity.ts";
import {
  type TelemetryKind,
  type TelemetryResultState,
  parseTelemetryResult,
  telemetryToolKind,
} from "./telemetry-result.ts";

type ToolUseDetail = { name?: string; input?: Record<string, unknown>; mcpServerName?: string };
type ToolResultDetail = {
  toolUseId?: string;
  isError?: boolean;
  truncated?: boolean;
  originalRowCount?: number;
  storedRowCount?: number;
};

function readToolUse(e: IncidentEvent): ToolUseDetail | null {
  const detail = e.detail as { toolUse?: ToolUseDetail } | null;
  return detail?.toolUse ?? null;
}

function readToolResult(e: IncidentEvent): ToolResultDetail | null {
  const detail = e.detail as { toolResult?: ToolResultDetail } | null;
  return detail?.toolResult ?? null;
}

export type TranscriptItem =
  | { type: "message"; id: string; text: string }
  | {
      type: "telemetry";
      id: string;
      kind: TelemetryKind;
      input: Record<string, unknown>;
      rows: Record<string, unknown>[];
      resultState: TelemetryResultState;
      originalRowCount: number | null;
      isError: boolean;
    }
  | {
      type: "tool";
      id: string;
      name: string;
      serverName?: string;
      input: Record<string, unknown>;
      result: string | null;
      isError: boolean;
    }
  | {
      type: "mcp_error";
      id: string;
      serverName: string | null;
      category: string;
      message: string;
    }
  | MemoryActivity
  | { type: "question"; id: string; question: string; awaiting: boolean }
  // The raw initial prompt is a system-generated brief (internal instructions +
  // telemetry dump), not user content, so it is intentionally not carried into
  // the feed — the node is a bare "Started investigation" marker.
  | { type: "start"; id: string };

export type FeedItem =
  | TranscriptItem
  | { type: "triggering_issue"; id: string; issueId: string; createdAt: string }
  | {
      type: "issue_activity";
      id: string;
      issueId: string;
      label: string;
      createdAt: string;
    }
  | { type: "human"; id: string; author: string | null; text: string; createdAt: string }
  | { type: "lifecycle"; id: string; event: IncidentEvent };

export type ActivityFeedOptions = {
  triggeringIssue?: { issueId: string; createdAt: string } | null;
};

const TOOL_USE_KINDS = new Set(["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"]);
const TOOL_RESULT_KINDS = new Set([
  "agent.tool_result",
  "agent.mcp_tool_result",
  "user.custom_tool_result",
]);

function isFeedNoise(kind: string): boolean {
  if (kind === "session.error") return false;
  if (kind === "linear_handoff_pending") return true;
  return kind.startsWith("span.") || kind.startsWith("session.");
}

function joinedIssueActivity(
  event: IncidentEvent,
): Extract<FeedItem, { type: "issue_activity" }> | null {
  if (event.kind !== "incident_context_changed") return null;
  const match = (event.summary ?? "").match(
    /^(New|Regressed) issue joined the incident(?: \(issue id:\s*([^)]+)\))?(?::|$)/,
  );
  if (!match) return null;
  const detailIssueId = event.detail?.issueId;
  const issueId = typeof detailIssueId === "string" ? detailIssueId : match[2]?.trim();
  if (!issueId) return null;
  return {
    type: "issue_activity",
    id: event.id,
    issueId,
    label: `${match[1]} issue joined the incident`,
    createdAt: event.createdAt,
  };
}

export function buildActivityFeed(
  events: IncidentEvent[],
  options: ActivityFeedOptions = {},
): FeedItem[] {
  const resultByUseId = new Map<string, IncidentEvent>();
  for (const event of events) {
    if (TOOL_RESULT_KINDS.has(event.kind)) {
      const id = readToolResult(event)?.toolUseId;
      if (id) resultByUseId.set(id, event);
    }
  }

  const items: FeedItem[] = options.triggeringIssue
    ? [
        {
          type: "triggering_issue",
          id: `triggering-issue-${options.triggeringIssue.issueId}`,
          issueId: options.triggeringIssue.issueId,
          createdAt: options.triggeringIssue.createdAt,
        },
      ]
    : [];
  for (const event of events) {
    const issueActivity = joinedIssueActivity(event);
    if (issueActivity) {
      items.push(issueActivity);
      continue;
    }
    const mcpError = (
      event.detail as {
        mcpError?: { serverName?: string; category?: string; message?: string };
      } | null
    )?.mcpError;
    if (mcpError) {
      items.push({
        type: "mcp_error",
        id: event.id,
        serverName: mcpError.serverName ?? null,
        category: mcpError.category ?? "connection",
        message: mcpError.message ?? event.summary ?? "MCP connection failed",
      });
      continue;
    }
    if (event.kind === "human_reply") {
      const origin = (event.detail as { origin?: { author?: string | null } } | null)?.origin;
      const text = (event.summary ?? "").trim();
      if (text) {
        items.push({
          type: "human",
          id: event.id,
          author: origin?.author ?? null,
          text,
          createdAt: event.createdAt,
        });
      }
      continue;
    }
    if (event.kind === "agent.message") {
      const text = (event.summary ?? "").trim();
      if (text) items.push({ type: "message", id: event.id, text });
      continue;
    }
    if (TOOL_USE_KINDS.has(event.kind)) {
      const use = readToolUse(event);
      const name = use?.name ?? "tool";
      const question = use?.input?.question;
      if (name === "ask_human" && typeof question === "string" && question.trim()) {
        items.push({
          type: "question",
          id: event.id,
          question: question.trim(),
          awaiting: false,
        });
        continue;
      }
      const result = resultByUseId.get(event.providerEventId ?? event.id) ?? null;
      const isError = result ? (readToolResult(result)?.isError ?? false) : false;
      const kind = telemetryToolKind(name);
      const memory = memoryActivityFromTool(
        event.id,
        name,
        use?.input ?? {},
        result?.summary ?? null,
        isError,
      );
      if (kind) {
        const resultDetail = result ? readToolResult(result) : null;
        const parsedResult = parseTelemetryResult(result?.summary, {
          truncated: resultDetail?.truncated,
          originalRowCount: resultDetail?.originalRowCount,
        });
        items.push({
          type: "telemetry",
          id: event.id,
          kind,
          input: use?.input ?? {},
          rows: parsedResult.rows,
          resultState: parsedResult.state,
          originalRowCount: parsedResult.originalRowCount,
          isError,
        });
      } else if (memory) {
        items.push(memory);
      } else if (name !== "submit_agent_run_result") {
        items.push({
          type: "tool",
          id: event.id,
          name,
          ...(use?.mcpServerName ? { serverName: use.mcpServerName } : {}),
          input: use?.input ?? {},
          result: result?.summary ?? null,
          isError,
        });
      }
      continue;
    }
    if (event.kind === "agent.thinking" || TOOL_RESULT_KINDS.has(event.kind)) continue;
    if (event.kind.startsWith("agent.") || isFeedNoise(event.kind)) continue;
    if (event.kind === "user.message") {
      items.push({ type: "start", id: event.id });
      continue;
    }
    if (event.kind === "awaiting_human") continue;
    items.push({ type: "lifecycle", id: event.id, event });
  }
  return items;
}

export function markAwaitingQuestion(feed: FeedItem[], question: string): FeedItem[] {
  const normalizedQuestion = question.trim();
  let matchingIndex = -1;
  for (let index = feed.length - 1; index >= 0; index--) {
    const item = feed[index];
    if (item?.type === "question" && item.question.trim() === normalizedQuestion) {
      matchingIndex = index;
      break;
    }
  }

  if (matchingIndex === -1) {
    return [
      ...feed,
      {
        type: "question",
        id: "awaiting-question",
        question,
        awaiting: true,
      },
    ];
  }

  return feed.map((item, index) =>
    index === matchingIndex && item.type === "question" ? { ...item, awaiting: true } : item,
  );
}

export function buildTranscript(events: IncidentEvent[]): TranscriptItem[] {
  return buildActivityFeed(events).filter(
    (item): item is TranscriptItem =>
      item.type !== "lifecycle" &&
      item.type !== "human" &&
      item.type !== "triggering_issue" &&
      item.type !== "issue_activity",
  );
}
