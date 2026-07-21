import crypto from "node:crypto";
import { db, encryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { logger } from "../logger.js";
import { requireProjectManagerContext } from "../org-authorization-http.js";
import { hasProjectManagerAccess } from "../org-authorization.js";
import { resolveActiveOrgContext } from "../org-context.js";
import { buildSentryAuthorizeUrl, signSentryState, verifySentryState } from "./oauth.js";

const log = logger.child({ scope: "sentry" });
const SENTRY_API_ORIGIN = "https://sentry.io";
const SENTRY_PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type Vars = { userId: string; orgId: string | null };

type SentryToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
};

type SentryGrant = {
  organizationSlug: string;
  sentryProjectSlug: string;
  sentryInstallationId: string;
};

function config() {
  return {
    clientId: process.env.SENTRY_CLIENT_ID,
    clientSecret: process.env.SENTRY_CLIENT_SECRET,
    appSlug: process.env.SENTRY_APP_SLUG,
    redirectUrl:
      process.env.SENTRY_OAUTH_REDIRECT_URL ?? "http://localhost:4100/sentry/oauth/callback",
    stateSecret: process.env.STATE_SIGNING_SECRET,
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSentryInstallationPublic(app: Hono<any>): void {
  const { clientId, clientSecret, appSlug, redirectUrl, stateSecret, webOrigin } = config();

  app.get("/sentry/oauth/callback", async (c) => {
    if (!clientId || !clientSecret || !appSlug || !stateSecret) {
      return c.json({ error: "sentry not configured" }, 503);
    }
    if (c.req.query("error")) return c.redirect(`${webOrigin}/settings?sentry=denied`, 302);
    const code = c.req.query("code");
    const sentryInstallationId = c.req.query("installationId");
    const organizationSlug = c.req.query("orgSlug");
    const state = verifySentryState(c.req.query("state") ?? "", stateSecret);
    if (!code || !sentryInstallationId || !organizationSlug || !state) {
      return c.json({ error: "invalid callback" }, 400);
    }
    if (
      !(await hasProjectManagerAccess({
        userId: state.userId,
        preferredOrgId: state.orgId,
        projectId: state.projectId,
      }))
    ) {
      return c.redirect(`${webOrigin}/settings?sentry=error`, 302);
    }

    try {
      const token = await exchangeSentryCode({ clientId, clientSecret, code, redirectUrl });
      const grant = await resolveSentryGrant({
        accessToken: token.accessToken,
        appSlug,
        organizationSlug,
        sentryInstallationId,
        sentryProjectSlug: state.sentryProjectSlug,
      });
      await installSentryGrant({
        projectId: state.projectId,
        actorUserId: state.userId,
        token,
        grant,
      });
      log.info(
        {
          org_id: state.orgId,
          project_id: state.projectId,
          sentry_organization_slug: grant.organizationSlug,
          sentry_project_slug: grant.sentryProjectSlug,
        },
        "sentry installed",
      );
      return c.redirect(`${webOrigin}/settings?sentry=installed`, 302);
    } catch (error) {
      log.error({ err: error }, "sentry oauth callback failed");
      return c.redirect(`${webOrigin}/settings?sentry=error`, 302);
    }
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSentryInstallationAuthed(app: Hono<any>): void {
  const { clientId, clientSecret, appSlug, redirectUrl, stateSecret } = config();

  app.get("/api/sentry/installation", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ installed: false });
    const installation = await findCurrentInstallation(ctx.projectId);
    if (!installation) return c.json({ installed: false });
    return c.json({
      installed: true,
      organizationSlug: installation.organizationSlug,
      projectSlug: installation.sentryProjectSlug,
      needsReauth: installation.reauthRequiredAt !== null,
      reauthReason: installation.reauthReason,
    });
  });

  app.post("/api/sentry/install-url", async (c) => {
    if (!clientId || !clientSecret || !appSlug || !stateSecret) {
      return c.json({ error: "sentry not configured" }, 503);
    }
    const ctx = await resolveUserOrgManager(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const body = (await c.req.json().catch(() => null)) as { projectSlug?: unknown } | null;
    const sentryProjectSlug =
      typeof body?.projectSlug === "string" ? body.projectSlug.trim().toLowerCase() : "";
    if (!SENTRY_PROJECT_SLUG.test(sentryProjectSlug)) {
      return c.json({ error: "valid Sentry project slug required" }, 400);
    }
    const state = signSentryState(
      {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        userId: ctx.userId,
        sentryProjectSlug,
      },
      stateSecret,
    );
    return c.json({ url: buildSentryAuthorizeUrl({ appSlug, state }) });
  });

  app.post("/api/sentry/uninstall", async (c) => {
    const ctx = await resolveUserOrgManager(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    await db
      .update(schema.sentryInstallations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.sentryInstallations.projectId, ctx.projectId),
          isNull(schema.sentryInstallations.revokedAt),
        ),
      );
    log.info({ org_id: ctx.orgId, project_id: ctx.projectId }, "sentry disconnected");
    return c.json({ ok: true });
  });
}

async function exchangeSentryCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUrl: string;
}): Promise<SentryToken> {
  const response = await fetch(`${SENTRY_API_ORIGIN}/oauth/token/`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUrl,
    }),
    redirect: "error",
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new Error(`Sentry OAuth exchange failed (${response.status})`);
  }
  const expiresAt =
    typeof payload.expires_at === "string"
      ? validDate(payload.expires_at)
      : typeof payload.expires_in === "number"
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null;
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    expiresAt,
  };
}

async function resolveSentryGrant(input: {
  accessToken: string;
  appSlug: string;
  organizationSlug: string;
  sentryInstallationId: string;
  sentryProjectSlug: string;
}): Promise<SentryGrant> {
  const projects = await sentryGet(
    input.accessToken,
    `/api/0/organizations/${encodeURIComponent(input.organizationSlug)}/projects/`,
  );
  if (
    !Array.isArray(projects) ||
    !projects.some((project) => isRecord(project) && project.slug === input.sentryProjectSlug)
  ) {
    throw new Error(`Sentry project ${input.sentryProjectSlug} is not accessible`);
  }
  const installations = await sentryGet(
    input.accessToken,
    `/api/0/organizations/${encodeURIComponent(input.organizationSlug)}/sentry-app-installations/`,
  );
  const installation = Array.isArray(installations)
    ? installations.find(
        (candidate) =>
          isRecord(candidate) &&
          candidate.uuid === input.sentryInstallationId &&
          (candidate.status === "installed" || candidate.status === "pending") &&
          isRecord(candidate.app) &&
          candidate.app.slug === input.appSlug,
      )
    : null;
  if (!isRecord(installation) || typeof installation.uuid !== "string") {
    throw new Error("Sentry App installation is not available for the selected organization");
  }
  if (installation.status === "pending") {
    await sentryPut(
      input.accessToken,
      `/api/0/sentry-app-installations/${encodeURIComponent(input.sentryInstallationId)}/`,
      { status: "installed" },
    );
  }
  return {
    organizationSlug: input.organizationSlug,
    sentryProjectSlug: input.sentryProjectSlug,
    sentryInstallationId: input.sentryInstallationId,
  };
}

async function sentryGet(accessToken: string, path: string): Promise<unknown> {
  const response = await fetch(`${SENTRY_API_ORIGIN}${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    redirect: "error",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Sentry API request failed (${response.status})`);
  return payload;
}

async function sentryPut(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${SENTRY_API_ORIGIN}${path}`, {
    method: "PUT",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Sentry installation verification failed (${response.status})`);
}

async function installSentryGrant(input: {
  projectId: string;
  actorUserId: string;
  token: SentryToken;
  grant: SentryGrant;
}): Promise<void> {
  const access = encryptIntegrationSecret(input.token.accessToken);
  const refresh = input.token.refreshToken
    ? encryptIntegrationSecret(input.token.refreshToken)
    : null;
  const relay = encryptIntegrationSecret(crypto.randomBytes(32).toString("base64url"));
  await db.transaction(async (tx) => {
    await tx
      .update(schema.sentryInstallations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.sentryInstallations.projectId, input.projectId),
          isNull(schema.sentryInstallations.revokedAt),
        ),
      );
    await tx.insert(schema.sentryInstallations).values({
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      sentryInstallationId: input.grant.sentryInstallationId,
      organizationSlug: input.grant.organizationSlug,
      sentryProjectSlug: input.grant.sentryProjectSlug,
      accessTokenCiphertext: access.ciphertext,
      accessTokenNonce: access.nonce.toString("base64"),
      accessTokenKeyVersion: access.keyVersion,
      refreshTokenCiphertext: refresh?.ciphertext ?? null,
      refreshTokenNonce: refresh?.nonce.toString("base64") ?? null,
      refreshTokenKeyVersion: refresh?.keyVersion ?? null,
      relayTokenCiphertext: relay.ciphertext,
      relayTokenNonce: relay.nonce.toString("base64"),
      relayTokenKeyVersion: relay.keyVersion,
      oauthExpiresAt: input.token.expiresAt,
    });
  });
}

function findCurrentInstallation(projectId: string) {
  return db.query.sentryInstallations.findFirst({
    where: and(
      eq(schema.sentryInstallations.projectId, projectId),
      isNull(schema.sentryInstallations.revokedAt),
    ),
  });
}

async function resolveUserOrg(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; orgId: string; projectId: string } | null> {
  const userId = c.var.userId;
  if (!userId) return null;
  const ctx = await resolveActiveOrgContext({ userId, preferredOrgId: c.var.orgId }).catch(
    () => null,
  );
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

function validDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
