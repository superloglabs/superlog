import { db, exchangeNotionCode, notionOwnerEmail, revokeNotionToken, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { logger } from "./logger.js";
import { signState, verifyState } from "./oauth-state.js";
import { requireProjectManagerContext } from "./org-authorization-http.js";
import { hasProjectManagerAccess } from "./org-authorization.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "notion" });

type Vars = { userId: string; orgId: string | null };

export function buildNotionAuthorizeUrl(args: {
  clientId: string;
  redirectUrl: string;
  state: string;
}): string {
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", args.redirectUrl);
  url.searchParams.set("state", args.state);
  return url.toString();
}

function config() {
  return {
    clientId: process.env.NOTION_CLIENT_ID,
    clientSecret: process.env.NOTION_CLIENT_SECRET,
    redirectUrl:
      process.env.NOTION_OAUTH_REDIRECT_URL ?? "http://localhost:4100/notion/oauth/callback",
    stateSecret: process.env.STATE_SIGNING_SECRET,
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountNotionPublic(app: Hono<any>): void {
  const { clientId, clientSecret, redirectUrl, stateSecret, webOrigin } = config();
  if (!clientId || !clientSecret) {
    log.warn("NOTION_CLIENT_ID/SECRET not set — /notion/oauth/callback disabled");
  }

  app.get("/notion/oauth/callback", async (c) => {
    if (!clientId || !clientSecret || !stateSecret) {
      return c.json({ error: "notion not configured" }, 503);
    }
    const err = c.req.query("error");
    if (err) return c.redirect(`${webOrigin}/settings?notion=denied`, 302);

    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    if (!code) return c.redirect(`${webOrigin}/settings?notion=error`, 302);

    const decoded = verifyState(state, stateSecret);
    if (!decoded) return c.json({ error: "invalid state" }, 400);
    if (
      !(await hasProjectManagerAccess({
        userId: decoded.userId,
        preferredOrgId: decoded.orgId,
        projectId: decoded.projectId,
      }))
    ) {
      return c.redirect(`${webOrigin}/settings?notion=error`, 302);
    }

    let token: Awaited<ReturnType<typeof exchangeNotionCode>>;
    try {
      token = await exchangeNotionCode({
        clientId,
        clientSecret,
        code,
        redirectUri: redirectUrl,
      });
    } catch (e) {
      log.error({ err: e }, "notion oauth exchange failed");
      return c.redirect(`${webOrigin}/settings?notion=error`, 302);
    }

    await upsertInstallation({
      projectId: decoded.projectId,
      actorUserId: decoded.userId,
      botId: token.bot_id,
      workspaceId: token.workspace_id,
      workspaceName: token.workspace_name ?? null,
      workspaceIcon: token.workspace_icon ?? null,
      actorEmail: notionOwnerEmail(token),
      accessToken: token.access_token,
    });
    log.info(
      {
        org_id: decoded.orgId,
        project_id: decoded.projectId,
        workspace_id: token.workspace_id,
        workspace_name: token.workspace_name,
        actor_user_id: decoded.userId,
      },
      "notion installed",
    );

    return c.redirect(`${webOrigin}/settings?notion=installed`, 302);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountNotionAuthed(app: Hono<any>): void {
  const { clientId, clientSecret, redirectUrl, stateSecret } = config();

  app.get("/api/notion/installation", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ installed: false });
    const row = await findCurrentInstallation(ctx.projectId);
    if (!row) return c.json({ installed: false });
    return c.json({
      installed: true,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspaceIcon: row.workspaceIcon,
      actorEmail: row.actorEmail,
      needsReauth: row.reauthRequiredAt !== null,
      reauthReason: row.reauthReason,
      reauthRequiredAt: row.reauthRequiredAt?.toISOString() ?? null,
    });
  });

  app.post("/api/notion/install-url", async (c) => {
    // clientSecret is required by the callback's token exchange, so gate the
    // whole flow on it here rather than sending the user into an OAuth we can't
    // complete.
    if (!clientId || !clientSecret || !stateSecret) {
      return c.json({ error: "notion not configured" }, 503);
    }
    const ctx = await resolveUserOrgManager(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);

    const state = signState(
      { orgId: ctx.orgId, projectId: ctx.projectId, userId: ctx.userId },
      stateSecret,
    );
    return c.json({ url: buildNotionAuthorizeUrl({ clientId, redirectUrl, state }) });
  });

  app.post("/api/notion/uninstall", async (c) => {
    const ctx = await resolveUserOrgManager(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const row = await findCurrentInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });

    if (clientId && clientSecret) {
      await revokeNotionToken({ clientId, clientSecret, token: row.accessToken });
    }
    await db
      .update(schema.notionInstallations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.notionInstallations.id, row.id));
    log.info(
      { org_id: ctx.orgId, workspace_id: row.workspaceId, actor_user_id: ctx.userId },
      "notion uninstalled",
    );
    return c.json({ ok: true });
  });
}

function findCurrentInstallation(projectId: string) {
  return db.query.notionInstallations.findFirst({
    where: and(
      eq(schema.notionInstallations.projectId, projectId),
      isNull(schema.notionInstallations.revokedAt),
    ),
  });
}

async function upsertInstallation(v: {
  projectId: string;
  actorUserId: string | null;
  botId: string;
  workspaceId: string;
  workspaceName: string | null;
  workspaceIcon: string | null;
  actorEmail: string | null;
  accessToken: string;
}): Promise<void> {
  // Per-project: revoke any existing active install so the partial unique index
  // (project_id WHERE revoked_at IS NULL) stays satisfied, then insert fresh.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.notionInstallations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.notionInstallations.projectId, v.projectId),
          isNull(schema.notionInstallations.revokedAt),
        ),
      );
    await tx.insert(schema.notionInstallations).values({
      projectId: v.projectId,
      actorUserId: v.actorUserId,
      botId: v.botId,
      workspaceId: v.workspaceId,
      workspaceName: v.workspaceName,
      workspaceIcon: v.workspaceIcon,
      actorEmail: v.actorEmail,
      accessToken: v.accessToken,
    });
  });
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

async function resolveUserOrgManager(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; orgId: string; projectId: string } | null> {
  const ctx = await resolveUserOrg(c);
  if (!ctx) return null;
  await requireProjectManagerContext(c, ctx.projectId);
  return ctx;
}
