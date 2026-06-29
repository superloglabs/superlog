import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "./client.js";
import * as schema from "./schema.js";

const DEFAULT_LOOPS_API_BASE = "https://app.loops.so/api/v1";
export const DEFAULT_LOOPS_WELCOME_EVENT = "superlogWelcome";

type LoopsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type LoopsApiOptions = {
  apiKey?: string | null;
  apiBase?: string;
  eventName?: string | null;
  fetch?: LoopsFetch;
};

export type LoopsWelcomeFlowInput = {
  user: {
    id: string;
    email: string;
  };
  org: {
    id: string;
    name: string;
    slug: string;
  };
  project: {
    id: string;
    name: string;
    slug: string;
  };
  signupSource: string | null;
  clerkOrgId?: string | null;
  appUrl?: string;
};

export type LoopsLifecycle = {
  telemetrySet: boolean;
  telemetrySetAt: string | null;
  githubAdded: boolean;
  githubAddedAt: string | null;
  slackAdded: boolean;
  slackAddedAt: string | null;
  mcpInstalled: boolean;
  mcpInstalledAt: string | null;
};

export type LoopsWelcomeEventPayload = {
  email: string;
  userId: string;
  eventName: string;
  source: string;
  eventProperties: Record<string, string>;
};

export type LoopsContactPayload = {
  email: string;
  userId: string;
  source: string;
  userGroup: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  signupSource: string;
  appUrl: string;
} & LoopsLifecycle;

export type SendLoopsResult =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "fetch_unavailable" };

function short(value: string | null | undefined, fallback = "unknown"): string {
  const normalized = value?.trim() || fallback;
  return normalized.slice(0, 500);
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function welcomeEventName(value: string | null | undefined): string {
  const eventName = short(value, DEFAULT_LOOPS_WELCOME_EVENT);
  if (eventName.includes(":")) {
    throw new Error("LOOPS_WELCOME_EVENT_NAME cannot contain ':'");
  }
  return eventName;
}

function loopsConfig(options: LoopsApiOptions) {
  const apiKey = (options.apiKey ?? process.env.LOOPS_API_KEY)?.trim();
  if (!apiKey) return { configured: false as const, reason: "not_configured" as const };

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) return { configured: false as const, reason: "fetch_unavailable" as const };

  return {
    configured: true as const,
    apiKey,
    fetchImpl,
    apiBase: (options.apiBase ?? process.env.LOOPS_API_BASE ?? DEFAULT_LOOPS_API_BASE).replace(
      /\/$/,
      "",
    ),
  };
}

async function loopsRequest(
  path: string,
  body: unknown,
  options: LoopsApiOptions,
): Promise<SendLoopsResult> {
  const cfg = loopsConfig(options);
  if (!cfg.configured) return { sent: false, reason: cfg.reason };

  const res = await cfg.fetchImpl(`${cfg.apiBase}${path}`, {
    method: path === "/contacts/update" ? "PUT" : "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Loops request failed: ${res.status} ${text.slice(0, 500)}`);
  }

  return { sent: true };
}

export function buildLoopsWelcomeEventPayload(
  input: LoopsWelcomeFlowInput,
  eventName = DEFAULT_LOOPS_WELCOME_EVENT,
): LoopsWelcomeEventPayload {
  return {
    email: input.user.email,
    userId: input.user.id,
    eventName: welcomeEventName(eventName),
    source: "Superlog signup",
    eventProperties: {
      userId: short(input.user.id),
      orgId: short(input.org.id),
      orgName: short(input.org.name),
      orgSlug: short(input.org.slug),
      projectId: short(input.project.id),
      projectName: short(input.project.name),
      projectSlug: short(input.project.slug),
      signupSource: short(input.signupSource, "web"),
      clerkOrgId: short(input.clerkOrgId),
      appUrl: short(input.appUrl, "https://superlog.sh"),
    },
  };
}

export function buildLoopsContactPayload(
  input: LoopsWelcomeFlowInput,
  lifecycle: LoopsLifecycle,
): LoopsContactPayload {
  return {
    email: input.user.email,
    userId: input.user.id,
    source: "Superlog",
    userGroup: "Users",
    orgId: short(input.org.id),
    orgName: short(input.org.name),
    orgSlug: short(input.org.slug),
    projectId: short(input.project.id),
    projectName: short(input.project.name),
    projectSlug: short(input.project.slug),
    signupSource: short(input.signupSource, "web"),
    appUrl: short(input.appUrl, "https://superlog.sh"),
    ...lifecycle,
  };
}

export async function fetchLoopsLifecycleForUserProject(params: {
  userId: string;
  orgId: string;
  projectId: string;
}): Promise<LoopsLifecycle> {
  const now = new Date();
  const [telemetryRows, githubRows, slackRows, mcpRows] = await Promise.all([
    db
      .select({ at: sql<Date | null>`max(${schema.apiKeys.lastUsedAt})` })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.projectId, params.projectId),
          isNull(schema.apiKeys.revokedAt),
          isNotNull(schema.apiKeys.lastUsedAt),
        ),
      ),
    db
      .select({ at: sql<Date | null>`min(${schema.githubInstallations.createdAt})` })
      .from(schema.githubInstallations)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.githubInstallations.projectId))
      .where(
        and(eq(schema.projects.orgId, params.orgId), isNull(schema.githubInstallations.revokedAt)),
      ),
    db
      .select({ at: sql<Date | null>`min(${schema.slackInstallations.createdAt})` })
      .from(schema.slackInstallations)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.slackInstallations.projectId))
      .where(
        and(eq(schema.projects.orgId, params.orgId), isNull(schema.slackInstallations.revokedAt)),
      ),
    db
      .select({ at: sql<Date | null>`min(${schema.mcpOauthTokens.createdAt})` })
      .from(schema.mcpOauthTokens)
      .where(
        and(
          eq(schema.mcpOauthTokens.userId, params.userId),
          eq(schema.mcpOauthTokens.projectId, params.projectId),
          isNull(schema.mcpOauthTokens.revokedAt),
          or(
            isNull(schema.mcpOauthTokens.refreshExpiresAt),
            gt(schema.mcpOauthTokens.refreshExpiresAt, now),
          ),
        ),
      ),
  ]);

  const telemetrySetAt = iso(telemetryRows[0]?.at);
  const githubAddedAt = iso(githubRows[0]?.at);
  const slackAddedAt = iso(slackRows[0]?.at);
  const mcpInstalledAt = iso(mcpRows[0]?.at);

  return {
    telemetrySet: telemetrySetAt !== null,
    telemetrySetAt,
    githubAdded: githubAddedAt !== null,
    githubAddedAt,
    slackAdded: slackAddedAt !== null,
    slackAddedAt,
    mcpInstalled: mcpInstalledAt !== null,
    mcpInstalledAt,
  };
}

export async function upsertLoopsContact(
  input: LoopsWelcomeFlowInput,
  options: LoopsApiOptions & { lifecycle?: LoopsLifecycle } = {},
): Promise<SendLoopsResult> {
  const lifecycle =
    options.lifecycle ??
    (await fetchLoopsLifecycleForUserProject({
      userId: input.user.id,
      orgId: input.org.id,
      projectId: input.project.id,
    }));
  const payload = buildLoopsContactPayload(input, lifecycle);
  return loopsRequest("/contacts/update", payload, options);
}

export async function sendLoopsWelcomeFlow(
  input: LoopsWelcomeFlowInput,
  options: LoopsApiOptions = {},
): Promise<SendLoopsResult> {
  const payload = buildLoopsWelcomeEventPayload(
    input,
    options.eventName ?? process.env.LOOPS_WELCOME_EVENT_NAME ?? DEFAULT_LOOPS_WELCOME_EVENT,
  );
  return loopsRequest("/events/send", payload, options);
}

// All members of an org (email + user id), for fanning a usage notification out
// to everyone. No role filter — "all members" per product decision.
export async function fetchOrgMemberContacts(
  orgId: string,
): Promise<Array<{ userId: string; email: string }>> {
  return db
    .select({ userId: schema.users.id, email: schema.users.email })
    .from(schema.orgMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
    .where(eq(schema.orgMembers.orgId, orgId));
}

export async function syncLoopsContactForUserProject(
  params: {
    userId: string;
    projectId: string;
    appUrl?: string;
  },
  options: LoopsApiOptions = {},
): Promise<SendLoopsResult> {
  const rows = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      orgId: schema.orgs.id,
      orgName: schema.orgs.name,
      orgSlug: schema.orgs.slug,
      signupSource: schema.orgs.signupSource,
      projectId: schema.projects.id,
      projectName: schema.projects.name,
      projectSlug: schema.projects.slug,
    })
    .from(schema.users)
    .innerJoin(schema.orgMembers, eq(schema.orgMembers.userId, schema.users.id))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
    .innerJoin(schema.projects, eq(schema.projects.orgId, schema.orgs.id))
    .where(and(eq(schema.users.id, params.userId), eq(schema.projects.id, params.projectId)))
    .limit(1);

  const row = rows[0];
  if (!row) return { sent: false, reason: "not_configured" };

  return upsertLoopsContact(
    {
      user: { id: row.userId, email: row.email },
      org: { id: row.orgId, name: row.orgName, slug: row.orgSlug },
      project: { id: row.projectId, name: row.projectName, slug: row.projectSlug },
      signupSource: row.signupSource,
      appUrl: params.appUrl,
    },
    options,
  );
}

export async function syncLoopsContactsForProject(
  params: {
    projectId: string;
    appUrl?: string;
  },
  options: LoopsApiOptions = {},
): Promise<void> {
  const members = await db
    .select({ userId: schema.orgMembers.userId })
    .from(schema.projects)
    .innerJoin(schema.orgMembers, eq(schema.orgMembers.orgId, schema.projects.orgId))
    .where(eq(schema.projects.id, params.projectId));

  await Promise.all(
    members.map((member) =>
      syncLoopsContactForUserProject(
        { userId: member.userId, projectId: params.projectId, appUrl: params.appUrl },
        options,
      ),
    ),
  );
}

export async function syncLoopsContactsForOrg(
  params: {
    orgId: string;
    appUrl?: string;
  },
  options: LoopsApiOptions = {},
): Promise<void> {
  const rows = await db
    .select({ userId: schema.orgMembers.userId, projectId: schema.projects.id })
    .from(schema.orgMembers)
    .innerJoin(schema.projects, eq(schema.projects.orgId, schema.orgMembers.orgId))
    .where(eq(schema.orgMembers.orgId, params.orgId));

  await Promise.all(
    rows.map((row) =>
      syncLoopsContactForUserProject(
        { userId: row.userId, projectId: row.projectId, appUrl: params.appUrl },
        options,
      ),
    ),
  );
}
