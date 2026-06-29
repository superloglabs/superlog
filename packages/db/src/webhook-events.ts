// Outbound webhook event builders + enqueue.
//
// This module is the single source of truth for the *shape* of every webhook
// payload Superlog sends, and for deciding which endpoints a given event goes
// to. It lives in @superlog/db (not in a single app) on purpose: incident
// lifecycle events fire from both the API (dashboard / Slack resolve) and the
// worker (agent runs, regression reopen, merge), so the enqueue side has to be
// reachable from both. The actual HTTP delivery + signing + retry loop is the
// worker's job (apps/worker/src/webhooks.ts) — this module only writes
// `webhook_deliveries` rows.
//
// MODEL: a webhook is "a message to relay" to an outgoing integration
// (Telegram, email, SMS, a custom relay, …), not a fine-grained state-machine
// event. There are exactly two events:
//
//   incident.created  → "post a new message / open a new thread"
//   incident.updated  → "reply in that thread / edit the message"
//
// Every meaningful thing that happens to an incident after it opens (resolve,
// reopen, merge, agent started / completed / failed / awaiting input) is an
// `incident.updated` distinguished by `change.kind`. Each payload also carries a
// render-ready `message` ({ title, body }) so a dumb relay can forward text
// without understanding the schema, *plus* the structured `incident` /
// `agentRun` / `change` for consumers that want to do their own rendering.
//
// `eventId` is unique per event (stable identity for de-dupe at the consumer);
// each *delivery* (incl. retries / redelivers) carries its own
// `Superlog-Delivery` id added at send time.

import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

// The default database singleton is imported lazily so that this module —
// which is pure payload-building plus a thin enqueue — can be unit-tested
// without DATABASE_URL set (client.js throws at import time when it's unset).
// Callers in the app always pass an explicit `database`, so the lazy import is
// only hit in the convenience-default path at real runtime.
async function defaultDatabase(): Promise<DB> {
  const { db } = await import("./client.js");
  return db;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Serializers — the external projection of each internal row. Deliberately a
// curated subset: Slack anchors, billing cooldowns and other operational
// columns are intentionally omitted. Treat these shapes as additive contracts.
// ---------------------------------------------------------------------------

export type WebhookProject = { id: string; name: string; slug: string };

export function serializeProject(project: schema.Project): WebhookProject {
  return { id: project.id, name: project.name, slug: project.slug };
}

export type WebhookIncident = {
  id: string;
  title: string;
  codename: string;
  status: string;
  severity: string | null;
  suggestedSeverity: string | null;
  service: string | null;
  environment: string | null;
  firstSeen: string;
  lastSeen: string;
  issueCount: number;
  agentSummary: string | null;
  rootCauseText: string | null;
  rootCauseConfidence: number | null;
  estimatedImpactText: string | null;
  estimatedImpactConfidence: number | null;
  noiseClassification: unknown;
  resolutionClassification: unknown;
  findingsAgentRunId: string | null;
  resolvedAt: string | null;
  resolvedByKind: string | null;
  resolvedReasonCode: string | null;
  resolvedReasonText: string | null;
  mergedIntoId: string | null;
  mergedAt: string | null;
};

export function serializeIncident(incident: schema.Incident): WebhookIncident {
  return {
    id: incident.id,
    title: incident.title,
    codename: incident.codename,
    status: incident.status,
    severity: incident.severity ?? null,
    suggestedSeverity: incident.suggestedSeverity ?? null,
    service: incident.service ?? null,
    environment: incident.environment ?? null,
    firstSeen: incident.firstSeen.toISOString(),
    lastSeen: incident.lastSeen.toISOString(),
    issueCount: incident.issueCount,
    agentSummary: incident.agentSummary ?? null,
    rootCauseText: incident.rootCauseText ?? null,
    rootCauseConfidence: incident.rootCauseConfidence ?? null,
    estimatedImpactText: incident.estimatedImpactText ?? null,
    estimatedImpactConfidence: incident.estimatedImpactConfidence ?? null,
    noiseClassification: incident.noiseClassification ?? null,
    resolutionClassification: incident.resolutionClassification ?? null,
    findingsAgentRunId: incident.findingsAgentRunId ?? null,
    resolvedAt: iso(incident.resolvedAt),
    resolvedByKind: incident.resolvedByKind ?? null,
    resolvedReasonCode: incident.resolvedReasonCode ?? null,
    resolvedReasonText: incident.resolvedReasonText ?? null,
    mergedIntoId: incident.mergedIntoId ?? null,
    mergedAt: iso(incident.mergedAt),
  };
}

export type WebhookAgentRun = {
  id: string;
  state: string;
  runtime: string;
  trigger: string;
  startedAt: string | null;
  completedAt: string | null;
  cumulativeRuntimeMinutes: number;
  resumeCount: number;
  failureReason: string | null;
  failureCategory: string | null;
  selectedRepoFullName: string | null;
  selectedBaseBranch: string | null;
  result: unknown;
};

export function serializeAgentRun(run: schema.AgentRun): WebhookAgentRun {
  let failureCategory: string | null = null;
  if (run.failureReason) {
    try {
      failureCategory = schema.agentRunFailureCategory(
        run.failureReason as schema.AgentRunFailureReason,
      );
    } catch {
      failureCategory = null;
    }
  }
  return {
    id: run.id,
    state: run.state,
    runtime: run.runtime,
    trigger: run.trigger,
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    cumulativeRuntimeMinutes: run.cumulativeRuntimeMinutes,
    resumeCount: run.resumeCount,
    failureReason: run.failureReason ?? null,
    failureCategory,
    selectedRepoFullName: run.selectedRepoFullName ?? null,
    selectedBaseBranch: run.selectedBaseBranch ?? null,
    result: run.result ?? null,
  };
}

export type WebhookIncidentEvent = {
  id: string;
  kind: string;
  summary: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

export type WebhookPullRequest = {
  id: string;
  repoFullName: string;
  prNumber: number;
  url: string;
  branchName: string;
  baseBranch: string;
  state: string;
  title: string | null;
  mergedAt: string | null;
  closedAt: string | null;
};

export type WebhookLinearTicket = {
  id: string;
  workspaceId: string;
  ticketId: string;
  ticketIdentifier: string | null;
  url: string | null;
  title: string | null;
  state: string | null;
};

// ---------------------------------------------------------------------------
// Change descriptors — the `change` body on every incident.updated event.
// ---------------------------------------------------------------------------

export type IncidentReopenedReason = "issue_regressed" | "manual";

export type AgentRunAwaitingReason =
  | "repository_selection"
  | "no_github_install"
  | "no_accessible_repos";

export type WebhookMergeTarget = {
  id: string;
  codename: string;
  title: string;
  status: string;
};

// The discriminated input a caller passes to describe what changed. Resolution
// detail (kind / reason / status) is read off the incident row inside the
// builder, so `resolved` carries no extra fields here.
export type IncidentChange =
  | { kind: "resolved" }
  | { kind: "reopened"; reason: IncidentReopenedReason; previousStatus: string | null }
  | { kind: "merged"; mergedInto: WebhookMergeTarget; evidence: string | null }
  | { kind: "agent_started" }
  | { kind: "agent_completed" }
  | { kind: "agent_failed" }
  | {
      kind: "agent_awaiting_input";
      reason: AgentRunAwaitingReason;
      summary: string;
      question: string | null;
    };

export type IncidentChangeKind = IncidentChange["kind"];

// ---------------------------------------------------------------------------
// Render-ready message. A relay (Telegram/email/SMS) can forward title + body
// verbatim without understanding the structured payload.
// ---------------------------------------------------------------------------

export type WebhookMessage = { title: string; body: string };

function agentResultDigest(result: unknown): { summary: string | null; prUrl: string | null } {
  if (!result || typeof result !== "object") return { summary: null, prUrl: null };
  const r = result as Record<string, unknown>;
  const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : null;
  let prUrl: string | null = null;
  const pr = r.pr;
  if (pr && typeof pr === "object") {
    const url = (pr as Record<string, unknown>).url;
    if (typeof url === "string" && url) prUrl = url;
  }
  return { summary, prUrl };
}

function renderCreatedMessage(incident: schema.Incident): WebhookMessage {
  const sev = incident.severity ?? incident.suggestedSeverity ?? null;
  const bits = [sev, incident.service ?? null, incident.environment ?? null].filter(
    (b): b is string => typeof b === "string" && b.length > 0,
  );
  const tail = bits.length > 0 ? ` (${bits.join(" · ")})` : "";
  return { title: incident.title, body: `New incident${tail}.` };
}

function renderUpdatedMessage(
  incident: schema.Incident,
  change: IncidentChange,
  agentRun: WebhookAgentRun | null,
): WebhookMessage {
  const title = incident.title;
  switch (change.kind) {
    case "resolved": {
      if (incident.status === "autoresolved_noise") {
        return { title, body: "Auto-closed as noise." };
      }
      const reason = incident.resolvedReasonText ?? incident.resolvedReasonCode ?? null;
      return { title, body: reason ? `Resolved: ${reason}` : "Resolved." };
    }
    case "reopened":
      return {
        title,
        body:
          change.reason === "issue_regressed"
            ? "Reopened — the underlying issue regressed."
            : "Reopened manually.",
      };
    case "merged":
      return {
        title,
        body: `Merged into ${change.mergedInto.codename} — ${change.mergedInto.title}.`,
      };
    case "agent_started":
      return { title, body: "Investigation started." };
    case "agent_completed": {
      const digest = agentResultDigest(agentRun?.result);
      const lead = digest.summary
        ? `Investigation complete: ${digest.summary}`
        : "Investigation complete.";
      return { title, body: digest.prUrl ? `${lead} Opened PR: ${digest.prUrl}` : lead };
    }
    case "agent_failed": {
      const reason = agentRun?.failureReason ?? null;
      return { title, body: reason ? `Investigation failed: ${reason}` : "Investigation failed." };
    }
    case "agent_awaiting_input": {
      const lead = change.summary?.trim() || "Investigation needs your input.";
      return { title, body: change.question ? `${lead} ${change.question}` : lead };
    }
  }
}

// ---------------------------------------------------------------------------
// Payload builders (pure; exported for tests)
// ---------------------------------------------------------------------------

export type IncidentCreatedPayload = {
  event: "incident.created";
  eventId: string;
  occurredAt: string;
  project: WebhookProject;
  incident: WebhookIncident;
  message: WebhookMessage;
};

export type IncidentUpdatedPayload = {
  event: "incident.updated";
  eventId: string;
  occurredAt: string;
  project: WebhookProject;
  incident: WebhookIncident;
  message: WebhookMessage;
  change: Record<string, unknown> & { kind: IncidentChangeKind };
  agentRun?: WebhookAgentRun;
  events?: WebhookIncidentEvent[];
  pullRequests?: WebhookPullRequest[];
  linearTickets?: WebhookLinearTicket[];
};

export function buildIncidentCreatedPayload(
  incident: schema.Incident,
  project: schema.Project,
): IncidentCreatedPayload {
  return {
    event: "incident.created",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    project: serializeProject(project),
    incident: serializeIncident(incident),
    message: renderCreatedMessage(incident),
  };
}

function changeBody(
  incident: schema.Incident,
  change: IncidentChange,
): Record<string, unknown> & { kind: IncidentChangeKind } {
  switch (change.kind) {
    case "resolved": {
      // The noise auto-close path flips status to `autoresolved_noise` and
      // stamps `noiseResolvedAt` / `noiseReason` rather than the `resolved*`
      // columns, so fall back to those for that terminal-resolve case instead
      // of emitting an all-null resolution block.
      const isNoise = incident.status === "autoresolved_noise";
      return {
        kind: "resolved",
        resolution: {
          kind: incident.resolvedByKind ?? (isNoise ? "autoresolved_noise" : null),
          reasonCode:
            incident.resolvedReasonCode ?? (isNoise ? (incident.noiseReason ?? null) : null),
          reasonText: incident.resolvedReasonText ?? null,
          resolvedAt: iso(incident.resolvedAt) ?? (isNoise ? iso(incident.noiseResolvedAt) : null),
          // Status disambiguates a plain resolve from a noise auto-close.
          status: incident.status,
        },
      };
    }
    case "reopened":
      return {
        kind: "reopened",
        reason: change.reason,
        previousStatus: change.previousStatus ?? null,
      };
    case "merged":
      return { kind: "merged", mergedInto: change.mergedInto, evidence: change.evidence ?? null };
    case "agent_started":
      return { kind: "agent_started" };
    case "agent_completed":
      return { kind: "agent_completed" };
    case "agent_failed":
      return { kind: "agent_failed" };
    case "agent_awaiting_input":
      return {
        kind: "agent_awaiting_input",
        reason: change.reason,
        summary: change.summary,
        question: change.question ?? null,
      };
  }
}

export function buildIncidentUpdatedPayload(
  incident: schema.Incident,
  project: schema.Project,
  change: IncidentChange,
  extras?: {
    agentRun?: WebhookAgentRun;
    events?: WebhookIncidentEvent[];
    pullRequests?: WebhookPullRequest[];
    linearTickets?: WebhookLinearTicket[];
  },
): IncidentUpdatedPayload {
  const agentRun = extras?.agentRun ?? null;
  const payload: IncidentUpdatedPayload = {
    event: "incident.updated",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    project: serializeProject(project),
    incident: serializeIncident(incident),
    message: renderUpdatedMessage(incident, change, agentRun),
    change: changeBody(incident, change),
  };
  if (agentRun) payload.agentRun = agentRun;
  if (extras?.events) payload.events = extras.events;
  if (extras?.pullRequests) payload.pullRequests = extras.pullRequests;
  if (extras?.linearTickets) payload.linearTickets = extras.linearTickets;
  return payload;
}

// ---------------------------------------------------------------------------
// Generic enqueue: fan an event out to every enabled endpoint subscribed to it.
// ---------------------------------------------------------------------------

export async function enqueueWebhookEvent(opts: {
  database?: DB;
  projectId: string;
  eventType: schema.WebhookEventType;
  payload: Record<string, unknown>;
}): Promise<number> {
  const database = opts.database ?? (await defaultDatabase());
  const endpoints = await database.query.webhookEndpoints.findMany({
    where: and(
      eq(schema.webhookEndpoints.projectId, opts.projectId),
      isNull(schema.webhookEndpoints.disabledAt),
    ),
  });
  const matching = endpoints.filter((endpoint) =>
    (endpoint.enabledEvents ?? []).includes(opts.eventType),
  );
  if (matching.length === 0) return 0;
  await database.insert(schema.webhookDeliveries).values(
    matching.map((endpoint) => ({
      endpointId: endpoint.id,
      eventType: opts.eventType,
      payload: opts.payload as unknown as Record<string, unknown>,
    })),
  );
  return matching.length;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadIncidentContext(
  database: DB,
  incidentId: string,
): Promise<{ incident: schema.Incident; project: schema.Project } | null> {
  const incident = await database.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) return null;
  const project = await database.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });
  if (!project) return null;
  return { incident, project };
}

async function loadAgentRunContext(
  database: DB,
  agentRunId: string,
): Promise<{ run: schema.AgentRun; incident: schema.Incident; project: schema.Project } | null> {
  const run = await database.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.id, agentRunId),
  });
  if (!run) return null;
  const ctx = await loadIncidentContext(database, run.incidentId);
  if (!ctx) return null;
  return { run, incident: ctx.incident, project: ctx.project };
}

// ---------------------------------------------------------------------------
// Per-event enqueue wrappers. Each loads the rows it needs, builds the payload,
// and fans out. They return the number of endpoints enqueued (0 when nobody
// subscribes). Callers should treat these as best-effort (wrap in try/catch);
// a webhook failure must never break the incident / agent-run flow.
//
// The function names mirror the incident/agent-run lifecycle moments so call
// sites read naturally, but under the hood `incident.created` is the only thing
// that emits the "created" event — everything else is an `incident.updated`
// carrying a `change.kind`.
// ---------------------------------------------------------------------------

export async function enqueueIncidentCreated(incidentId: string, database?: DB): Promise<number> {
  const dbx = database ?? (await defaultDatabase());
  const ctx = await loadIncidentContext(dbx, incidentId);
  if (!ctx) return 0;
  return enqueueWebhookEvent({
    database: dbx,
    projectId: ctx.project.id,
    eventType: "incident.created",
    payload: buildIncidentCreatedPayload(ctx.incident, ctx.project),
  });
}

async function enqueueIncidentUpdate(
  dbx: DB,
  incidentId: string,
  change: IncidentChange,
  extras?: Parameters<typeof buildIncidentUpdatedPayload>[3],
): Promise<number> {
  const ctx = await loadIncidentContext(dbx, incidentId);
  if (!ctx) return 0;
  return enqueueWebhookEvent({
    database: dbx,
    projectId: ctx.project.id,
    eventType: "incident.updated",
    payload: buildIncidentUpdatedPayload(ctx.incident, ctx.project, change, extras),
  });
}

export async function enqueueIncidentResolved(incidentId: string, database?: DB): Promise<number> {
  const dbx = database ?? (await defaultDatabase());
  return enqueueIncidentUpdate(dbx, incidentId, { kind: "resolved" });
}

export async function enqueueIncidentReopened(
  incidentId: string,
  opts: { reason: IncidentReopenedReason; previousStatus?: string | null },
  database?: DB,
): Promise<number> {
  const dbx = database ?? (await defaultDatabase());
  return enqueueIncidentUpdate(dbx, incidentId, {
    kind: "reopened",
    reason: opts.reason,
    previousStatus: opts.previousStatus ?? null,
  });
}

export async function enqueueIncidentMerged(
  incidentId: string,
  opts: { targetIncidentId: string; evidence: string | null },
  database?: DB,
): Promise<number> {
  const dbx = database ?? (await defaultDatabase());
  const target = await dbx.query.incidents.findFirst({
    where: eq(schema.incidents.id, opts.targetIncidentId),
  });
  if (!target) return 0;
  return enqueueIncidentUpdate(dbx, incidentId, {
    kind: "merged",
    mergedInto: {
      id: target.id,
      codename: target.codename,
      title: target.title,
      status: target.status,
    },
    evidence: opts.evidence,
  });
}

export async function enqueueAgentRunStarted(agentRunId: string, database?: DB): Promise<number> {
  const dbx = database ?? (await defaultDatabase());
  const ctx = await loadAgentRunContext(dbx, agentRunId);
  if (!ctx) return 0;
  return enqueueWebhookEvent({
    database: dbx,
    projectId: ctx.project.id,
    eventType: "incident.updated",
    payload: buildIncidentUpdatedPayload(
      ctx.incident,
      ctx.project,
      { kind: "agent_started" },
      { agentRun: serializeAgentRun(ctx.run) },
    ),
  });
}

export async function enqueueAgentRunFailed(agentRunId: string, database?: DB): Promise<number> {
  const dbx = database ?? (await defaultDatabase());
  const ctx = await loadAgentRunContext(dbx, agentRunId);
  if (!ctx) return 0;
  return enqueueWebhookEvent({
    database: dbx,
    projectId: ctx.project.id,
    eventType: "incident.updated",
    payload: buildIncidentUpdatedPayload(
      ctx.incident,
      ctx.project,
      { kind: "agent_failed" },
      { agentRun: serializeAgentRun(ctx.run) },
    ),
  });
}

export async function enqueueAgentRunAwaitingInput(
  agentRunId: string,
  opts: { reason: AgentRunAwaitingReason; summary: string; question: string | null },
  database?: DB,
): Promise<number> {
  const dbx = database ?? (await defaultDatabase());
  const ctx = await loadAgentRunContext(dbx, agentRunId);
  if (!ctx) return 0;
  return enqueueWebhookEvent({
    database: dbx,
    projectId: ctx.project.id,
    eventType: "incident.updated",
    payload: buildIncidentUpdatedPayload(
      ctx.incident,
      ctx.project,
      {
        kind: "agent_awaiting_input",
        reason: opts.reason,
        summary: opts.summary,
        question: opts.question ?? null,
      },
      { agentRun: serializeAgentRun(ctx.run) },
    ),
  });
}

// ---------------------------------------------------------------------------
// agent_completed: the richest update. In addition to `agentRun` it embeds the
// run's chronological events, opened PRs and filed Linear tickets.
// ---------------------------------------------------------------------------

export type AgentRunCompletedPayload = IncidentUpdatedPayload;

export async function buildAgentRunCompletedPayload(
  database: DB,
  agentRunId: string,
): Promise<{ projectId: string; payload: AgentRunCompletedPayload } | null> {
  const ctx = await loadAgentRunContext(database, agentRunId);
  if (!ctx) return null;
  const { run, incident, project } = ctx;

  const [eventRows, prRows, ticketRows] = await Promise.all([
    database.query.incidentEvents.findMany({
      where: eq(schema.incidentEvents.agentRunId, agentRunId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    }),
    database.query.agentPullRequests.findMany({
      where: eq(schema.agentPullRequests.agentRunId, agentRunId),
    }),
    database.query.agentLinearTickets.findMany({
      where: eq(schema.agentLinearTickets.agentRunId, agentRunId),
    }),
  ]);

  const payload = buildIncidentUpdatedPayload(
    incident,
    project,
    { kind: "agent_completed" },
    {
      agentRun: serializeAgentRun(run),
      events: eventRows.map((e) => ({
        id: e.id,
        kind: e.kind,
        summary: e.summary,
        detail: e.detail ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
      pullRequests: prRows.map((p) => ({
        id: p.id,
        repoFullName: p.repoFullName,
        prNumber: p.prNumber,
        url: p.url,
        branchName: p.branchName,
        baseBranch: p.baseBranch,
        state: p.state,
        title: p.title,
        mergedAt: iso(p.mergedAt),
        closedAt: iso(p.closedAt),
      })),
      linearTickets: ticketRows.map((t) => ({
        id: t.id,
        workspaceId: t.workspaceId,
        ticketId: t.ticketId,
        ticketIdentifier: t.ticketIdentifier,
        url: t.url,
        title: t.title,
        state: t.state,
      })),
    },
  );

  return { projectId: project.id, payload };
}

export async function enqueueAgentRunCompleted(agentRunId: string, database?: DB): Promise<number> {
  const dbx = database ?? (await defaultDatabase());
  const built = await buildAgentRunCompletedPayload(dbx, agentRunId);
  if (!built) return 0;
  return enqueueWebhookEvent({
    database: dbx,
    projectId: built.projectId,
    eventType: "incident.updated",
    payload: built.payload as unknown as Record<string, unknown>,
  });
}
