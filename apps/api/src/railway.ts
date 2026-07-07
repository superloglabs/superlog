// Railway integration routes: a "Connect Railway" button via Login with
// Railway OAuth. Mirrors the Vercel/Cloudflare connector conventions, with one
// structural difference: Railway has no drain/export product, so nothing is
// provisioned on Railway's side. The OAuth grant itself is the integration —
// a `project:viewer` token that the worker-side puller (apps/worker) uses to
// read logs and metrics from the granted Railway projects and forward them to
// our intake with the ingest key minted here.
//
// Flow:
//   1. (authed)  POST /api/projects/:projectId/railway/install-url
//                → Railway consent URL (signed state carries org/project/user)
//   2. user approves on railway.com, picking which Railway projects to share
//   3. (public)  GET  /railway/oauth/callback → exchange code, snapshot the
//      granted projects, mint the ingest key, persist the install
//   4. (authed)  GET  /api/projects/:projectId/railway/installation → status
//                POST /api/projects/:projectId/railway/uninstall → remove
//
// The callback lives outside /api/* so it isn't behind the session middleware —
// it's authenticated by the HMAC-signed `state`, exactly like the other
// connectors' callbacks.

import {
  db,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  mintApiKey,
  schema,
} from "@superlog/db";
import {
  type RailwayOAuthConfig,
  buildAuthorizeUrl,
  decodeIdTokenSub,
  exchangeCodeForToken,
  fetchGrantedProjects,
  fetchViewer,
  railwayConfigFromEnv,
} from "@superlog/railway";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";
import { signState, verifyState } from "./oauth-state.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "railway" });

type Vars = { userId: string; orgId: string | null };

type RailwayInstallationRow = typeof schema.railwayInstallations.$inferSelect;

export type RailwayConnectOutcome = "installed" | "denied" | "error" | "no_projects";

/** Web path the OAuth callback redirects to — the dedicated result page. */
export function connectResultPath(outcome: RailwayConnectOutcome | string): string {
  return `/connect/railway?railway=${encodeURIComponent(outcome)}`;
}

class RailwayProvisioningError extends Error {
  constructor(
    message: string,
    readonly outcome: RailwayConnectOutcome,
  ) {
    super(message);
  }
}

/** Public shape — never leaks token ciphertext. */
function toPublic(row: RailwayInstallationRow) {
  return {
    installed: true,
    railwayUserId: row.railwayUserId,
    grantedProjects: row.grantedProjects ?? [],
    scope: row.scope,
    installedAt: row.createdAt,
  };
}

// Resolve the project the request targets from the path param and confirm the
// caller's active org owns it (same discipline as the Vercel connector —
// installs are per-project, so the project must be explicit).
async function requireProjectAccess(
  c: Context<{ Variables: Vars }>,
  projectId: string,
): Promise<{ userId: string; orgId: string; projectId: string }> {
  const userId = c.var.userId;
  if (!userId) throw new HTTPException(401, { message: "unauthenticated" });
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
  });
  if (!project) throw new HTTPException(404, { message: "project not found" });
  const ctx = await resolveActiveOrgContext({ userId, preferredOrgId: c.var.orgId });
  if (project.orgId !== ctx.org.id) throw new HTTPException(403, { message: "forbidden" });
  return { userId: ctx.user.id, orgId: ctx.org.id, projectId };
}

// The single active install for a project (enforced at provision time by the
// supersede step; `orderBy` is belt-and-suspenders).
async function findInstallation(projectId: string) {
  return db.query.railwayInstallations.findFirst({
    where: and(
      eq(schema.railwayInstallations.projectId, projectId),
      isNull(schema.railwayInstallations.revokedAt),
    ),
    orderBy: desc(schema.railwayInstallations.createdAt),
  });
}

/**
 * Get (or mint) the ingest key the puller forwards telemetry with. Reuses the
 * installation's stored key when it's still live so a re-consent doesn't
 * orphan a working key; mints a fresh one otherwise.
 */
async function ensureIngestKey(
  projectId: string,
  existing: RailwayInstallationRow | null,
): Promise<{ ingestKey: string; apiKeyId: string; minted: boolean }> {
  if (existing?.apiKeyId && existing.ingestKeyCiphertext && existing.ingestKeyNonce) {
    const keyRow = await db.query.apiKeys.findFirst({
      where: eq(schema.apiKeys.id, existing.apiKeyId),
    });
    if (keyRow && keyRow.revokedAt == null) {
      const ingestKey = decryptIntegrationSecret({
        ciphertext: existing.ingestKeyCiphertext,
        nonce: existing.ingestKeyNonce,
        keyVersion: existing.ingestKeyKeyVersion ?? 1,
      });
      return { ingestKey, apiKeyId: existing.apiKeyId, minted: false };
    }
  }
  const minted = await mintApiKey({ projectId, name: "Railway puller" });
  return { ingestKey: minted.plaintext, apiKeyId: minted.id, minted: true };
}

/**
 * Tear down one installation row. There is nothing to delete on Railway's
 * side (no drains, and Railway exposes no token-revocation endpoint — the
 * user can revoke the grant under railway.com → Authorized Apps); revoking
 * the ingest key stops our intake accepting anything the puller would
 * forward, and the soft-revoke stops the puller reading Railway at all.
 */
async function teardownInstallation(row: RailwayInstallationRow): Promise<void> {
  if (row.apiKeyId) {
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.apiKeyId));
  }
  await db
    .update(schema.railwayInstallations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.railwayInstallations.id, row.id));
}

export function mountRailwayPublic(
  app: Hono<{ Variables: Vars }>,
  deps: { config?: RailwayOAuthConfig | null; fetchImpl?: typeof fetch } = {},
): void {
  const config = deps.config !== undefined ? deps.config : railwayConfigFromEnv();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  if (!config) {
    log.warn("RAILWAY_CLIENT_ID/SECRET not set — Railway connect disabled");
  }

  app.get("/railway/oauth/callback", async (c) => {
    if (!config || !stateSecret) {
      return c.json({ error: "railway not configured" }, 503);
    }
    const err = c.req.query("error");
    if (err) {
      log.warn({ error: err }, "railway oauth callback denied");
      return c.redirect(`${webOrigin}${connectResultPath("denied")}`, 302);
    }
    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    if (!code) return c.redirect(`${webOrigin}${connectResultPath("error")}`, 302);

    const decoded = verifyState(state, stateSecret);
    if (!decoded) {
      log.warn("railway oauth callback rejected: invalid or expired state");
      return c.redirect(`${webOrigin}${connectResultPath("error")}`, 302);
    }

    const token = await exchangeCodeForToken({ config, code, fetchImpl });
    if (!token.ok) {
      log.error({ error: token.error }, "railway token exchange failed");
      return c.redirect(`${webOrigin}${connectResultPath("error")}`, 302);
    }

    try {
      await provisionInstallation({
        projectId: decoded.projectId,
        userId: decoded.userId,
        token,
        fetchImpl,
      });
    } catch (e) {
      log.error({ err: e, project_id: decoded.projectId }, "railway provisioning failed");
      const outcome = e instanceof RailwayProvisioningError ? e.outcome : "error";
      return c.redirect(`${webOrigin}${connectResultPath(outcome)}`, 302);
    }

    log.info({ project_id: decoded.projectId }, "railway connected");
    return c.redirect(`${webOrigin}${connectResultPath("installed")}`, 302);
  });
}

/**
 * Exchange complete → snapshot the grant and persist the install. Unlike the
 * Vercel flow there are no remote resources to create, so the only rollback
 * concern is a freshly minted ingest key.
 */
async function provisionInstallation(input: {
  projectId: string;
  userId: string | null;
  token: {
    ok: true;
    accessToken: string;
    refreshToken: string | null;
    expiresInSeconds: number | null;
    scope: string | null;
    idToken: string | null;
  };
  fetchImpl: typeof fetch;
}): Promise<void> {
  // The consenting Railway user keys the install row. The id_token usually
  // carries it; fall back to the API otherwise.
  let railwayUserId = decodeIdTokenSub(input.token.idToken);
  if (!railwayUserId) {
    const viewer = await fetchViewer({
      accessToken: input.token.accessToken,
      fetchImpl: input.fetchImpl,
    });
    if (!viewer.ok) {
      throw new RailwayProvisioningError(`railway viewer lookup failed: ${viewer.error}`, "error");
    }
    railwayUserId = viewer.viewer.id;
  }

  // Snapshot what the grant can see. An empty grant would leave the puller
  // with nothing to read — surface it so the user re-consents with projects
  // selected instead of landing on a "connected" install that never ingests.
  const granted = await fetchGrantedProjects({
    accessToken: input.token.accessToken,
    fetchImpl: input.fetchImpl,
  });
  if (!granted.ok) {
    throw new RailwayProvisioningError(
      `railway grant discovery failed: ${granted.error}`,
      "error",
    );
  }
  if (granted.projects.length === 0) {
    throw new RailwayProvisioningError("railway grant has no projects", "no_projects");
  }

  const existing = await db.query.railwayInstallations.findFirst({
    where: and(
      eq(schema.railwayInstallations.projectId, input.projectId),
      eq(schema.railwayInstallations.railwayUserId, railwayUserId),
      isNull(schema.railwayInstallations.revokedAt),
    ),
  });
  const { ingestKey, apiKeyId, minted } = await ensureIngestKey(
    input.projectId,
    existing ?? null,
  );

  try {
    const accessCipher = encryptIntegrationSecret(input.token.accessToken);
    const refreshCipher = input.token.refreshToken
      ? encryptIntegrationSecret(input.token.refreshToken)
      : null;
    const ingestCipher = encryptIntegrationSecret(ingestKey);
    const now = new Date();
    const tokenExpiresAt = input.token.expiresInSeconds
      ? new Date(now.getTime() + input.token.expiresInSeconds * 1000)
      : null;

    await db
      .insert(schema.railwayInstallations)
      .values({
        projectId: input.projectId,
        railwayUserId,
        grantedProjects: granted.projects,
        accessTokenCiphertext: accessCipher.ciphertext,
        accessTokenNonce: accessCipher.nonce,
        accessTokenKeyVersion: accessCipher.keyVersion,
        refreshTokenCiphertext: refreshCipher?.ciphertext ?? null,
        refreshTokenNonce: refreshCipher?.nonce ?? null,
        refreshTokenKeyVersion: refreshCipher?.keyVersion ?? null,
        tokenExpiresAt,
        scope: input.token.scope,
        apiKeyId,
        ingestKeyCiphertext: ingestCipher.ciphertext,
        ingestKeyNonce: ingestCipher.nonce,
        ingestKeyKeyVersion: ingestCipher.keyVersion,
        installedByUserId: input.userId,
      })
      .onConflictDoUpdate({
        target: [
          schema.railwayInstallations.projectId,
          schema.railwayInstallations.railwayUserId,
        ],
        set: {
          grantedProjects: granted.projects,
          accessTokenCiphertext: accessCipher.ciphertext,
          accessTokenNonce: accessCipher.nonce,
          accessTokenKeyVersion: accessCipher.keyVersion,
          refreshTokenCiphertext: refreshCipher?.ciphertext ?? null,
          refreshTokenNonce: refreshCipher?.nonce ?? null,
          refreshTokenKeyVersion: refreshCipher?.keyVersion ?? null,
          tokenExpiresAt,
          scope: input.token.scope,
          apiKeyId,
          ingestKeyCiphertext: ingestCipher.ciphertext,
          ingestKeyNonce: ingestCipher.nonce,
          ingestKeyKeyVersion: ingestCipher.keyVersion,
          installedByUserId: input.userId,
          // A re-consent resurrects a previously revoked install and resets
          // the puller's checkpoints (the old cursor may be far in the past).
          logCursor: null,
          metricsCursor: null,
          revokedAt: null,
          updatedAt: now,
        },
      });
  } catch (e) {
    // Roll back a key we minted for this connect; a reused key predates the
    // failure and stays.
    if (minted) {
      await db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(schema.apiKeys.id, apiKeyId));
    }
    throw e;
  }

  // Enforce a single active install per project: soft-revoke rows keyed to a
  // different Railway user. Best-effort — never turns a persisted connect into
  // an error redirect.
  try {
    const superseded = await db.query.railwayInstallations.findMany({
      where: and(
        eq(schema.railwayInstallations.projectId, input.projectId),
        ne(schema.railwayInstallations.railwayUserId, railwayUserId),
        isNull(schema.railwayInstallations.revokedAt),
      ),
    });
    for (const row of superseded) {
      await teardownInstallation(row);
    }
  } catch (e) {
    log.warn(
      { err: e, project_id: input.projectId },
      "railway post-connect cleanup failed (connection persisted)",
    );
  }
}

export function mountRailwayAuthed(
  app: Hono<{ Variables: Vars }>,
  deps: { config?: RailwayOAuthConfig | null } = {},
): void {
  const config = deps.config !== undefined ? deps.config : railwayConfigFromEnv();
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/projects/:projectId/railway/installation", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ installed: false });
    return c.json(toPublic(row));
  });

  app.post("/api/projects/:projectId/railway/install-url", async (c) => {
    if (!config || !stateSecret) {
      return c.json({ error: "railway not configured" }, 503);
    }
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));

    const state = signState(
      { orgId: ctx.orgId, projectId: ctx.projectId, userId: ctx.userId },
      stateSecret,
    );
    const url = buildAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
    });
    log.info({ org_id: ctx.orgId, project_id: ctx.projectId }, "railway install url created");
    return c.json({ url });
  });

  app.post("/api/projects/:projectId/railway/uninstall", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });
    await teardownInstallation(row);
    return c.json({ ok: true });
  });
}
