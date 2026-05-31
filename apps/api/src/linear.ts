import crypto from "node:crypto";
import {
  createLinearWebhook,
  db,
  deleteLinearWebhook,
  exchangeLinearCode,
  fetchLinearViewer,
  revokeLinearToken,
  schema,
} from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "./logger.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "linear" });

const SCOPES = "read,write,issues:create,comments:create";

type Vars = { userId: string; orgId: string | null };

export function buildLinearAuthorizeUrl(args: {
  clientId: string;
  redirectUrl: string;
  state: string;
}): string {
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUrl);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", args.state);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("actor", "app");
  return url.toString();
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountLinearPublic(app: Hono<any>): void {
  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  const redirectUrl =
    process.env.LINEAR_OAUTH_REDIRECT_URL ?? "http://localhost:4100/linear/oauth/callback";
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  if (!clientId || !clientSecret) {
    log.warn("LINEAR_CLIENT_ID/SECRET not set — /linear/oauth/callback disabled");
  }

  app.get("/linear/oauth/callback", async (c) => {
    if (!clientId || !clientSecret || !stateSecret) {
      return c.json({ error: "linear not configured" }, 503);
    }
    const err = c.req.query("error");
    if (err) return c.redirect(`${webOrigin}/settings?linear=denied`, 302);

    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    if (!code) return c.redirect(`${webOrigin}/settings?linear=error`, 302);

    const decoded = verifyState(state, stateSecret);
    if (!decoded) return c.json({ error: "invalid state" }, 400);

    let token: Awaited<ReturnType<typeof exchangeLinearCode>>;
    try {
      token = await exchangeLinearCode({
        clientId,
        clientSecret,
        code,
        redirectUri: redirectUrl,
      });
    } catch (e) {
      log.error({ err: e }, "linear oauth exchange failed");
      return c.redirect(`${webOrigin}/settings?linear=error`, 302);
    }

    let viewer: Awaited<ReturnType<typeof fetchLinearViewer>>;
    try {
      viewer = await fetchLinearViewer(token.access_token);
    } catch (e) {
      log.error({ err: e }, "linear viewer fetch failed");
      return c.redirect(`${webOrigin}/settings?linear=error`, 302);
    }

    const expiresAt =
      typeof token.expires_in === "number" ? new Date(Date.now() + token.expires_in * 1000) : null;

    const webhook = await registerLinearWebhookSafely(token.access_token);
    await upsertInstallation({
      projectId: decoded.projectId,
      actorUserId: decoded.userId,
      workspaceId: viewer.organization.id,
      workspaceName: viewer.organization.name,
      workspaceUrlKey: viewer.organization.urlKey,
      actorEmail: viewer.email,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      accessExpiresAt: expiresAt,
      scope: token.scope ?? null,
      webhookId: webhook?.id ?? null,
      webhookSecret: webhook?.secret ?? null,
    });
    log.info(
      {
        org_id: decoded.orgId,
        project_id: decoded.projectId,
        workspace_id: viewer.organization.id,
        workspace_name: viewer.organization.name,
        actor_user_id: decoded.userId,
      },
      "linear installed",
    );

    return c.redirect(`${webOrigin}/settings?linear=installed`, 302);
  });

  app.post("/linear/webhook", async (c) => {
    const rawBody = await c.req.text();
    const sigHeader = c.req.header("linear-signature") ?? "";
    const delivery = c.req.header("linear-delivery") ?? null;

    let parsed: LinearWebhookPayload;
    try {
      parsed = JSON.parse(rawBody) as LinearWebhookPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const webhookId = typeof parsed.webhookId === "string" ? parsed.webhookId : null;
    if (!webhookId) return c.json({ error: "missing webhookId" }, 400);

    const install = await db.query.linearInstallations.findFirst({
      where: eq(schema.linearInstallations.webhookId, webhookId),
    });
    if (!install || !install.webhookSecret) {
      log.warn({ webhook_id: webhookId }, "linear webhook from unknown installation");
      return c.json({ error: "unknown webhook" }, 404);
    }
    if (!verifyLinearSignature(rawBody, sigHeader, install.webhookSecret)) {
      log.warn({ webhook_id: webhookId, delivery }, "linear webhook signature failed");
      return c.json({ error: "bad signature" }, 401);
    }

    try {
      await handleLinearWebhook(parsed, install, delivery);
    } catch (e) {
      log.error({ err: e, webhook_id: webhookId }, "linear webhook handler failed");
      return c.json({ error: "handler failed" }, 500);
    }
    return c.json({ ok: true });
  });
}

type LinearWebhookActor = { id?: string; name?: string; avatarUrl?: string | null } | null;
type LinearWebhookPayload = {
  action?: string; // create | update | remove
  type?: string; // Issue | Comment | ...
  webhookId?: string;
  webhookTimestamp?: number;
  createdAt?: string;
  updatedFrom?: Record<string, unknown> | null;
  data?: {
    id?: string;
    identifier?: string;
    title?: string;
    body?: string;
    url?: string;
    issueId?: string;
    issue?: { id?: string };
    state?: { id?: string; name?: string; type?: string };
    assignee?: LinearWebhookActor;
    user?: LinearWebhookActor;
  };
  actor?: LinearWebhookActor;
};

function verifyLinearSignature(body: string, header: string, secret: string): boolean {
  if (!header) return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

async function handleLinearWebhook(
  payload: LinearWebhookPayload,
  install: schema.LinearInstallation,
  delivery: string | null,
): Promise<void> {
  const type = payload.type;
  const action = payload.action;
  if (!type || !action) return;

  const issueId =
    type === "Issue"
      ? payload.data?.id
      : type === "Comment"
        ? (payload.data?.issueId ?? payload.data?.issue?.id)
        : null;
  if (!issueId) return;

  const ticket = await db.query.agentLinearTickets.findFirst({
    where: and(
      eq(schema.agentLinearTickets.workspaceId, install.workspaceId),
      eq(schema.agentLinearTickets.ticketId, issueId),
    ),
  });
  if (!ticket) return;

  const occurredAt = payload.createdAt ? new Date(payload.createdAt) : new Date();

  if (type === "Issue" && action === "update") {
    const data = payload.data ?? {};
    const updates: Partial<typeof schema.agentLinearTickets.$inferInsert> = {
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    };
    if (typeof data.title === "string") updates.title = data.title;
    if (typeof data.identifier === "string") updates.ticketIdentifier = data.identifier;
    if (typeof data.url === "string") updates.url = data.url;
    if (data.state?.name) updates.state = data.state.name;
    if (data.state?.type) {
      updates.stateType = data.state.type as schema.AgentLinearTicketState;
    }
    if (data.assignee) {
      updates.assigneeName = data.assignee.name ?? null;
      updates.assigneeLinearId = data.assignee.id ?? null;
    }
    await db
      .update(schema.agentLinearTickets)
      .set(updates)
      .where(eq(schema.agentLinearTickets.id, ticket.id));
  }

  const { kind, summary, actor } = describeLinearEvent(payload);
  if (!kind) return;

  await db
    .insert(schema.agentLinearTicketEvents)
    .values({
      agentLinearTicketId: ticket.id,
      kind,
      summary,
      actorName: actor?.name ?? null,
      actorLinearId: actor?.id ?? null,
      actorAvatarUrl: actor?.avatarUrl ?? null,
      payload: payload as unknown as Record<string, unknown>,
      providerEventId: delivery,
      occurredAt,
    })
    .onConflictDoNothing();
}

function describeLinearEvent(payload: LinearWebhookPayload): {
  kind: string | null;
  summary: string | null;
  actor: LinearWebhookActor;
} {
  const actor = payload.actor ?? null;
  const type = payload.type;
  const action = payload.action;
  if (type === "Issue") {
    if (action === "update") {
      const stateChanged =
        payload.updatedFrom && Object.prototype.hasOwnProperty.call(payload.updatedFrom, "stateId");
      if (stateChanged) {
        return {
          kind: "ticket_state_changed",
          summary: payload.data?.state?.name
            ? `State → ${payload.data.state.name}`
            : "Ticket state changed",
          actor,
        };
      }
      return { kind: "ticket_updated", summary: "Ticket updated", actor };
    }
    if (action === "remove") return { kind: "ticket_removed", summary: "Ticket deleted", actor };
    return { kind: null, summary: null, actor };
  }
  if (type === "Comment") {
    if (action === "create") {
      return {
        kind: "ticket_comment",
        summary: "Comment on ticket",
        actor: payload.data?.user ?? actor,
      };
    }
    return { kind: null, summary: null, actor };
  }
  return { kind: null, summary: null, actor };
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountLinearAuthed(app: Hono<any>): void {
  const clientId = process.env.LINEAR_CLIENT_ID;
  const redirectUrl =
    process.env.LINEAR_OAUTH_REDIRECT_URL ?? "http://localhost:4100/linear/oauth/callback";
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/linear/installation", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ installed: false });
    const row = await findCurrentInstallation(ctx.projectId);
    if (!row) return c.json({ installed: false });
    return c.json({
      installed: true,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspaceUrlKey: row.workspaceUrlKey,
      actorEmail: row.actorEmail,
      scope: row.scope,
      needsReauth: row.reauthRequiredAt !== null,
      reauthReason: row.reauthReason,
      reauthRequiredAt: row.reauthRequiredAt?.toISOString() ?? null,
    });
  });

  app.post("/api/linear/install-url", async (c) => {
    if (!clientId || !stateSecret) {
      return c.json({ error: "linear not configured" }, 503);
    }
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);

    const state = signState(
      { orgId: ctx.orgId, projectId: ctx.projectId, userId: ctx.userId },
      stateSecret,
    );
    return c.json({ url: buildLinearAuthorizeUrl({ clientId, redirectUrl, state }) });
  });

  app.post("/api/linear/uninstall", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const row = await findCurrentInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });

    if (row.webhookId) {
      await deleteLinearWebhook({ accessToken: row.accessToken, webhookId: row.webhookId });
    }
    await revokeLinearToken(row.accessToken);
    await db
      .update(schema.linearInstallations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.linearInstallations.id, row.id));
    log.info(
      { org_id: ctx.orgId, workspace_id: row.workspaceId, actor_user_id: ctx.userId },
      "linear uninstalled",
    );
    return c.json({ ok: true });
  });
}

async function findCurrentInstallation(projectId: string) {
  return db.query.linearInstallations.findFirst({
    where: and(
      eq(schema.linearInstallations.projectId, projectId),
      isNull(schema.linearInstallations.revokedAt),
    ),
  });
}

async function upsertInstallation(v: {
  projectId: string;
  actorUserId: string | null;
  workspaceId: string;
  workspaceName: string | null;
  workspaceUrlKey: string | null;
  actorEmail: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  scope: string | null;
  webhookId: string | null;
  webhookSecret: string | null;
}): Promise<void> {
  // Per-project: revoke any existing active install in this project so the
  // partial unique index (project_id WHERE revoked_at IS NULL) stays satisfied.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.linearInstallations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.linearInstallations.projectId, v.projectId),
          isNull(schema.linearInstallations.revokedAt),
        ),
      );
    await tx.insert(schema.linearInstallations).values({
      projectId: v.projectId,
      actorUserId: v.actorUserId,
      workspaceId: v.workspaceId,
      workspaceName: v.workspaceName,
      workspaceUrlKey: v.workspaceUrlKey,
      actorEmail: v.actorEmail,
      accessToken: v.accessToken,
      refreshToken: v.refreshToken,
      accessExpiresAt: v.accessExpiresAt,
      scope: v.scope,
      webhookId: v.webhookId,
      webhookSecret: v.webhookSecret,
    });
  });
}

function getApiBaseUrl(): string | null {
  const raw = process.env.API_BASE_URL;
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

async function registerLinearWebhookSafely(
  accessToken: string,
): Promise<{ id: string; secret: string } | null> {
  const apiBase = getApiBaseUrl();
  if (!apiBase || apiBase.includes("localhost") || apiBase.includes("127.0.0.1")) {
    log.info("API_BASE_URL not public — skipping Linear webhook registration");
    return null;
  }
  try {
    const webhook = await createLinearWebhook({
      accessToken,
      url: `${apiBase}/linear/webhook`,
      resourceTypes: ["Issue", "Comment"],
      label: "Superlog",
    });
    return webhook;
  } catch (e) {
    log.error({ err: e }, "linear webhookCreate failed — continuing without webhook");
    return null;
  }
}

async function resolveUserOrg(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; orgId: string; projectId: string } | null> {
  const userId = c.var.userId;
  if (!userId) return null;
  const ctx = await resolveActiveOrgContext({
    userId,
    preferredOrgId: c.var.orgId,
  }).catch(() => null);
  if (!ctx) return null;
  return { userId: ctx.user.id, orgId: ctx.org.id, projectId: ctx.project.id };
}

type StatePayload = { orgId: string; projectId: string; userId: string };

function signState(p: StatePayload, secret: string): string {
  const body = `${p.orgId}.${p.projectId}.${p.userId}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sig}`;
}

function verifyState(state: string, secret: string): StatePayload | null {
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) return null;
  const body = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const provided = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(provided, expectedBuf)) return null;
  // Current format is `${orgId}.${projectId}.${userId}.${ts}` (4 parts). Old
  // 3-part states (no projectId) are rejected — they expire in 10 min so worst
  // case is a user mid-install during deploy seeing one error and retrying.
  const parts = body.split(".");
  if (parts.length !== 4) return null;
  const [orgId, projectId, userId, tsRaw] = parts as [string, string, string, string];
  if (!orgId || !projectId || !userId || !tsRaw) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > 10 * 60 * 1000) return null;
  return { orgId, projectId, userId };
}
