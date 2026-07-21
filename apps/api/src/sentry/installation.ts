import crypto from "node:crypto";
import { type SentryCredential, db, encryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { logger } from "../logger.js";
import { requireProjectManagerContext } from "../org-authorization-http.js";
import { hasProjectManagerAccess } from "../org-authorization.js";
import { type SentryInstallationToken, requestSentryInstallationToken } from "./authorization.js";
import { sentryProjectIsAccessible } from "./client.js";
import {
  type SentryOAuthState,
  buildSentryAuthorizeUrl,
  signSentryState,
  verifySentryState,
} from "./oauth.js";

const log = logger.child({ scope: "sentry" });
const SENTRY_API_ORIGIN = "https://sentry.io";
const SENTRY_PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type Vars = { userId: string; orgId: string | null };

type SentryGrant = {
  organizationSlug: string;
  sentryProjectSlug: string;
  sentryInstallationId: string;
};

export type SentryInstallationDeps = {
  importOpenIssues(input: {
    accessToken: string;
    organizationSlug: string;
    projectSlug: string;
    installationId: string;
    targetProjectId: string;
  }): Promise<number>;
  getActiveCredential(projectId: string): Promise<SentryCredential | null>;
};

function config() {
  return {
    clientId: process.env.SENTRY_CLIENT_ID,
    clientSecret: process.env.SENTRY_CLIENT_SECRET,
    appSlug: process.env.SENTRY_APP_SLUG,
    stateSecret: process.env.STATE_SIGNING_SECRET,
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSentryInstallationPublic(app: Hono<any>, deps: SentryInstallationDeps): void {
  const { clientId, clientSecret, appSlug, stateSecret, webOrigin } = config();

  app.get("/sentry/oauth/callback", async (c) => {
    if (!clientId || !clientSecret || !appSlug || !stateSecret) {
      return c.json({ error: "sentry not configured" }, 503);
    }
    if (c.req.query("error")) {
      const rawState = c.req.query("state");
      const state = rawState ? verifySentryState(rawState, stateSecret) : null;
      return c.redirect(
        sentryOAuthRedirect(webOrigin, state?.returnTo ?? "settings", "denied"),
        302,
      );
    }
    const callback = parseSentryInstallationCallback(
      {
        code: c.req.query("code"),
        installationId: c.req.query("installationId"),
        state: c.req.query("state"),
      },
      stateSecret,
    );
    if (!callback) {
      return c.json({ error: "invalid callback" }, 400);
    }
    if (
      !(await hasProjectManagerAccess({
        userId: callback.state.userId,
        preferredOrgId: callback.state.orgId,
        projectId: callback.state.projectId,
      }))
    ) {
      return c.redirect(sentryOAuthRedirect(webOrigin, callback.state.returnTo, "error"), 302);
    }

    try {
      const token = await exchangeSentryInstallationGrant({
        clientId,
        clientSecret,
        code: callback.code,
        installationId: callback.installationId,
      });
      const grant = await resolveSentryGrant({
        accessToken: token.accessToken,
        appSlug,
        sentryInstallationId: callback.installationId,
        sentryProjectSlug: callback.state.sentryProjectSlug,
      });
      await installSentryGrant({
        projectId: callback.state.projectId,
        actorUserId: callback.state.userId,
        token,
        grant,
      });
      const importInput = {
        accessToken: token.accessToken,
        organizationSlug: grant.organizationSlug,
        projectSlug: grant.sentryProjectSlug,
        installationId: grant.sentryInstallationId,
        targetProjectId: callback.state.projectId,
      };
      startSentryOpenIssueImport(
        () => deps.importOpenIssues(importInput),
        (importedIssueCount) => {
          log.info(
            {
              project_id: callback.state.projectId,
              imported_issue_count: importedIssueCount,
            },
            "sentry open issues imported",
          );
        },
        (error) => {
          log.warn(
            { err: error, project_id: callback.state.projectId },
            "sentry open issue import failed",
          );
        },
      );
      log.info(
        {
          org_id: callback.state.orgId,
          project_id: callback.state.projectId,
          sentry_organization_slug: grant.organizationSlug,
          sentry_project_slug: grant.sentryProjectSlug,
        },
        "sentry installed",
      );
      return c.redirect(sentryOAuthRedirect(webOrigin, callback.state.returnTo, "installed"), 302);
    } catch (error) {
      log.error({ err: error }, "sentry oauth callback failed");
      return c.redirect(sentryOAuthRedirect(webOrigin, callback.state.returnTo, "error"), 302);
    }
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSentryInstallationAuthed(app: Hono<any>, deps: SentryInstallationDeps): void {
  const { clientId, clientSecret, appSlug, stateSecret } = config();

  app.get("/api/projects/:projectId/sentry/installation", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectManagerContext(c, projectId);
    const installation = await findCurrentInstallation(projectId);
    if (!installation) return c.json({ installed: false });
    return c.json({
      installed: true,
      organizationSlug: installation.organizationSlug,
      projectSlug: installation.sentryProjectSlug,
      needsReauth: installation.reauthRequiredAt !== null,
      reauthReason: installation.reauthReason,
    });
  });

  app.post("/api/projects/:projectId/sentry/install-url", async (c) => {
    if (!clientId || !clientSecret || !appSlug || !stateSecret) {
      return c.json({ error: "sentry not configured" }, 503);
    }
    const projectId = c.req.param("projectId");
    const ctx = await requireProjectManagerContext(c, projectId);
    const body = (await c.req.json().catch(() => null)) as {
      projectSlug?: unknown;
      returnTo?: unknown;
    } | null;
    const sentryProjectSlug =
      typeof body?.projectSlug === "string" ? body.projectSlug.trim().toLowerCase() : "";
    if (!SENTRY_PROJECT_SLUG.test(sentryProjectSlug)) {
      return c.json({ error: "valid Sentry project slug required" }, 400);
    }
    const returnTo = body?.returnTo === "onboarding" ? "onboarding" : "settings";
    const state = signSentryState(
      {
        orgId: ctx.access.orgId,
        projectId,
        userId: ctx.access.userId,
        sentryProjectSlug,
        returnTo,
      },
      stateSecret,
    );
    return c.json({ url: buildSentryAuthorizeUrl({ appSlug, state }) });
  });

  app.post("/api/projects/:projectId/sentry/uninstall", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await requireProjectManagerContext(c, projectId);
    await db
      .update(schema.sentryInstallations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.sentryInstallations.projectId, projectId),
          isNull(schema.sentryInstallations.revokedAt),
        ),
      );
    log.info({ org_id: ctx.access.orgId, project_id: projectId }, "sentry disconnected");
    return c.json({ ok: true });
  });

  app.post("/api/projects/:projectId/sentry/import-open-issues", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectManagerContext(c, projectId);
    const credential = await deps.getActiveCredential(projectId);
    if (!credential) return c.json({ error: "sentry not installed" }, 404);
    const imported = await deps.importOpenIssues({
      accessToken: credential.accessToken,
      organizationSlug: credential.organizationSlug,
      projectSlug: credential.projectSlug,
      installationId: credential.sentryInstallationId,
      targetProjectId: projectId,
    });
    return c.json({ imported });
  });
}

export function startSentryOpenIssueImport(
  importIssues: () => Promise<number>,
  onComplete: (count: number) => void,
  onError: (error: unknown) => void,
): void {
  void Promise.resolve().then(importIssues).then(onComplete, onError);
}

export function sentryOAuthRedirect(
  webOrigin: string,
  returnTo: SentryOAuthState["returnTo"],
  outcome: "installed" | "denied" | "error",
): string {
  const path = returnTo === "onboarding" ? "/" : "/settings";
  return `${webOrigin.replace(/\/$/, "")}${path}?sentry=${outcome}`;
}

export function parseSentryInstallationCallback(
  query: { code?: string; installationId?: string; state?: string },
  stateSecret: string,
  now = Date.now(),
): { code: string; installationId: string; state: SentryOAuthState } | null {
  if (!query.code || !query.installationId || !query.state) return null;
  const state = verifySentryState(query.state, stateSecret, now);
  return state ? { code: query.code, installationId: query.installationId, state } : null;
}

export function exchangeSentryInstallationGrant(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  installationId: string;
  fetchImpl?: typeof fetch;
}): Promise<SentryInstallationToken> {
  return requestSentryInstallationToken({
    installationId: input.installationId,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    grant: { type: "authorization_code", code: input.code },
    fetchImpl: input.fetchImpl,
  });
}

async function resolveSentryGrant(input: {
  accessToken: string;
  appSlug: string;
  sentryInstallationId: string;
  sentryProjectSlug: string;
}): Promise<SentryGrant> {
  const installation = await completeSentryInstallation({
    accessToken: input.accessToken,
    installationId: input.sentryInstallationId,
  });
  if (installation.appSlug !== input.appSlug) {
    throw new Error("Sentry App installation belongs to a different app");
  }
  if (
    !(await sentryProjectIsAccessible({
      accessToken: input.accessToken,
      organizationSlug: installation.organizationSlug,
      projectSlug: input.sentryProjectSlug,
    }))
  ) {
    throw new Error(`Sentry project ${input.sentryProjectSlug} is not accessible`);
  }
  return {
    organizationSlug: installation.organizationSlug,
    sentryProjectSlug: input.sentryProjectSlug,
    sentryInstallationId: input.sentryInstallationId,
  };
}

export async function completeSentryInstallation(input: {
  accessToken: string;
  installationId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ installationId: string; appSlug: string; organizationSlug: string }> {
  const response = await (input.fetchImpl ?? fetch)(
    `${SENTRY_API_ORIGIN}/api/0/sentry-app-installations/${encodeURIComponent(input.installationId)}/`,
    {
      method: "PUT",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "installed" }),
      redirect: "error",
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Sentry installation verification failed (${response.status})`);
  if (
    !isRecord(payload) ||
    payload.uuid !== input.installationId ||
    payload.status !== "installed" ||
    !isRecord(payload.app) ||
    typeof payload.app.slug !== "string" ||
    !isRecord(payload.organization) ||
    typeof payload.organization.slug !== "string"
  ) {
    throw new Error("Sentry installation verification returned an invalid response");
  }
  return {
    installationId: input.installationId,
    appSlug: payload.app.slug,
    organizationSlug: payload.organization.slug,
  };
}

async function installSentryGrant(input: {
  projectId: string;
  actorUserId: string;
  token: SentryInstallationToken;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
