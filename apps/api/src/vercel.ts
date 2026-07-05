// Vercel integration routes: a Slack-style OAuth "Connect Vercel" button.
//
// Flow (the authed routes are project-scoped — installs are per project, so the
// project must be explicit in the path rather than inferred from the caller's
// "active" project):
//   1. (authed)  POST /api/projects/:projectId/vercel/install-url
//                → external-flow install URL (signed state carries org/project/user)
//   2. user approves the install on vercel.com
//   3. (public)  GET  /vercel/oauth/callback   → exchange code, then use the
//      granted token to create a Drain that exports OTLP traces to our intake
//      with a project ingest key.
//   4. (authed)  GET  /api/projects/:projectId/vercel/installation → status
//                POST /api/projects/:projectId/vercel/uninstall → remove install
//
// The callback lives outside /api/* so it isn't behind the session middleware —
// it's authenticated by the HMAC-signed `state`, exactly like the Cloudflare
// and Slack connectors' callbacks.

import {
  db,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  mintApiKey,
  schema,
} from "@superlog/db";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";
import { resolveActiveOrgContext } from "./org-context.js";
import {
  VERCEL_SIGNALS,
  type VercelConnectConfig,
  VercelProvisioningError,
  buildDrainPayload,
  buildInstallUrl,
  classifyDrainProvisioningFailure,
  connectResultPath,
  createDrain,
  deleteConfiguration,
  deleteDrain,
  exchangeCodeForToken,
  fetchTeamName,
  signState,
  staleDrainIds,
  vercelConfigFromEnv,
  verifyState,
} from "./vercel-service.js";

const log = logger.child({ scope: "vercel" });

type Vars = { userId: string; orgId: string | null };

type VercelInstallationRow = typeof schema.vercelInstallations.$inferSelect;

/** Public shape — never leaks token ciphertext. */
function toPublic(row: VercelInstallationRow) {
  return {
    installed: true,
    teamId: row.teamId ?? "",
    teamName: row.teamName,
    configurationId: row.configurationId,
    drains: row.drains ?? {},
    installedAt: row.createdAt,
  };
}

// Resolve the project the request targets from the path param and confirm the
// caller's active org owns it. Vercel installs are per-project (the table is
// keyed by (project, configuration)), so the project must be explicit —
// inferring the user's "active" project here would connect/disconnect the wrong
// project when Settings is viewing a different one.
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

// The single active install for a project. We enforce one active configuration
// per project at provision time (see provisionInstallation), so this is
// unambiguous; `orderBy` is belt-and-suspenders for any legacy multi-row state.
async function findInstallation(projectId: string) {
  return db.query.vercelInstallations.findFirst({
    where: and(
      eq(schema.vercelInstallations.projectId, projectId),
      isNull(schema.vercelInstallations.revokedAt),
    ),
    orderBy: desc(schema.vercelInstallations.createdAt),
  });
}

/**
 * Get (or mint) the ingest key the drain authenticates with. Reuses the
 * installation's stored key when it's still live so a reconnect doesn't orphan
 * a working key; mints a fresh one otherwise.
 */
async function ensureIngestKey(
  projectId: string,
  existing: VercelInstallationRow | null,
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
  const minted = await mintApiKey({ projectId, name: "Vercel OTLP" });
  return { ingestKey: minted.plaintext, apiKeyId: minted.id, minted: true };
}

/**
 * Best-effort delete the drains we created under one installation (by id).
 * Used both when re-provisioning the same configuration (so the new drains
 * don't stack on top of the old ones) and when tearing down a superseded
 * install. Empty ids are skipped.
 */
async function deleteRemoteDrains(input: {
  teamId: string | null;
  accessToken: string;
  drains: Record<string, string> | null | undefined;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const ids = Object.values(input.drains ?? {}).filter((id) => id.length > 0);
  for (const drainId of ids) {
    const res = await deleteDrain({
      teamId: input.teamId,
      accessToken: input.accessToken,
      drainId,
      fetchImpl: input.fetchImpl,
    });
    if (!res.ok) {
      log.warn({ drain_id: drainId, team_id: input.teamId }, "vercel drain delete failed");
    }
  }
}

/**
 * Fully tear down one installation row: delete its remote drains, delete the
 * integration configuration (Vercel's analog of a token revoke — the token
 * stops working and the install disappears from the user's team), revoke the
 * ingest key the drains authenticate with, and soft-revoke the row. Each remote
 * step is best-effort (the install may already be gone); the ingest-key revoke
 * is the backstop that actually stops telemetry being accepted at our intake.
 * Shared by uninstall and configuration-switch supersede.
 */
async function teardownInstallation(
  row: VercelInstallationRow,
  deps: { fetchImpl: typeof fetch },
): Promise<void> {
  let accessToken: string | null = null;
  try {
    accessToken = decryptIntegrationSecret({
      ciphertext: row.accessTokenCiphertext,
      nonce: row.accessTokenNonce,
      keyVersion: row.accessTokenKeyVersion,
    });
  } catch (e) {
    log.warn({ err: e, configuration_id: row.configurationId }, "vercel token decrypt failed");
  }

  if (accessToken) {
    await deleteRemoteDrains({
      teamId: row.teamId,
      accessToken,
      drains: row.drains,
      fetchImpl: deps.fetchImpl,
    });
    const res = await deleteConfiguration({
      teamId: row.teamId,
      accessToken,
      configurationId: row.configurationId,
      fetchImpl: deps.fetchImpl,
    });
    if (!res.ok) {
      log.warn(
        { configuration_id: row.configurationId },
        "vercel configuration delete failed (may already be uninstalled)",
      );
    }
  }

  // Revoke the ingest key the drains authenticate with. Without this any drain
  // we couldn't delete remotely keeps streaming into the project.
  if (row.apiKeyId) {
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.apiKeyId));
  }

  await db
    .update(schema.vercelInstallations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.vercelInstallations.id, row.id));
}

export function mountVercelPublic(
  app: Hono<{ Variables: Vars }>,
  deps: { config?: VercelConnectConfig | null; fetchImpl?: typeof fetch } = {},
): void {
  const config = deps.config !== undefined ? deps.config : vercelConfigFromEnv();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  if (!config) {
    log.warn(
      "VERCEL_CLIENT_ID/SECRET/INTEGRATION_SLUG/OTLP_INTAKE_URL not set — Vercel connect disabled",
    );
  }

  app.get("/vercel/oauth/callback", async (c) => {
    if (!config || !stateSecret) {
      return c.json({ error: "vercel not configured" }, 503);
    }
    const err = c.req.query("error");
    if (err) {
      log.warn({ error: err }, "vercel oauth callback denied");
      return c.redirect(`${webOrigin}${connectResultPath("denied")}`, 302);
    }
    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    if (!code) return c.redirect(`${webOrigin}${connectResultPath("error")}`, 302);

    const decoded = verifyState(state, stateSecret);
    if (!decoded) {
      log.warn("vercel oauth callback rejected: invalid or expired state");
      return c.redirect(`${webOrigin}${connectResultPath("error")}`, 302);
    }

    const token = await exchangeCodeForToken({ config, code, fetchImpl });
    if (!token.ok) {
      log.error({ error: token.error }, "vercel token exchange failed");
      return c.redirect(`${webOrigin}${connectResultPath("error")}`, 302);
    }

    try {
      await provisionInstallation({
        projectId: decoded.projectId,
        userId: decoded.userId,
        token,
        config,
        fetchImpl,
      });
    } catch (e) {
      // Provisioning throws when it can't produce a usable connection (e.g. the
      // drain couldn't be created — we never persist a connection that can't
      // receive telemetry, which would unlock onboarding as "connected" with
      // nothing flowing). Surface as an error so the flow can reset rather than
      // spin in the waiting state.
      log.error({ err: e, project_id: decoded.projectId }, "vercel provisioning failed");
      const outcome = e instanceof VercelProvisioningError ? e.outcome : "error";
      return c.redirect(`${webOrigin}${connectResultPath(outcome)}`, 302);
    }

    log.info(
      { project_id: decoded.projectId, team_id: token.teamId },
      "vercel connected and drain provisioned",
    );
    return c.redirect(`${webOrigin}${connectResultPath("installed")}`, 302);
  });
}

/**
 * Exchange complete → create the OTLP drain and persist the install. Factored
 * out of the route so the orchestration is one readable unit.
 */
async function provisionInstallation(input: {
  projectId: string;
  userId: string | null;
  token: {
    ok: true;
    accessToken: string;
    installationId: string;
    userId: string | null;
    teamId: string | null;
  };
  config: VercelConnectConfig;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const existing = (await findInstallation(input.projectId)) ?? null;
  // Only reuse the stored ingest key when re-provisioning the *same*
  // configuration (a replayed callback / re-consent on the same install); a new
  // configuration must get a fresh key so the superseded install's key can be
  // revoked independently (otherwise both installs share one live key).
  const sameConfiguration =
    existing?.configurationId === input.token.installationId ? existing : null;
  const { ingestKey, apiKeyId, minted } = await ensureIngestKey(
    input.projectId,
    sameConfiguration,
  );

  // Undo everything this run created that isn't safely persisted to an install
  // row: the new remote drains (minus any id the prior same-configuration row
  // still owns), a freshly minted ingest key, and — when nothing got persisted —
  // the just-installed configuration. Called on *every* pre-commit failure path
  // so a connect never leaves an orphaned drain/key/install behind. Best-effort
  // throughout.
  const rollback = async (created: Record<string, string>): Promise<void> => {
    const priorIds = new Set(Object.values(sameConfiguration?.drains ?? {}));
    const orphaned = Object.fromEntries(
      Object.entries(created).filter(([, id]) => !priorIds.has(id)),
    );
    await deleteRemoteDrains({
      teamId: input.token.teamId,
      accessToken: input.token.accessToken,
      drains: orphaned,
      fetchImpl: input.fetchImpl,
    });
    if (minted) {
      await db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(schema.apiKeys.id, apiKeyId));
    }
    // Only delete the configuration when no install row depends on it — on a
    // same-configuration re-provision the prior row's token is this token.
    if (!sameConfiguration) {
      await deleteConfiguration({
        teamId: input.token.teamId,
        accessToken: input.token.accessToken,
        configurationId: input.token.installationId,
        fetchImpl: input.fetchImpl,
      });
    }
  };

  // Create the new drains first; we only tear down any prior same-configuration
  // drains *after* a replacement lands (see below). Deleting up front would
  // leave the project "connected" with zero live drains if creation fails.
  const drains: Record<string, string> = {};
  const drainErrors: string[] = [];
  for (const signal of VERCEL_SIGNALS) {
    const result = await createDrain({
      teamId: input.token.teamId,
      accessToken: input.token.accessToken,
      payload: buildDrainPayload({
        signal,
        intakeBaseUrl: input.config.intakeBaseUrl,
        ingestKey,
        projectId: input.projectId,
      }),
      fetchImpl: input.fetchImpl,
    });
    if (result.ok) {
      drains[signal] = result.id;
    } else {
      drainErrors.push(result.error);
      // Don't abort the whole connect on one signal — log and continue so the
      // user still gets the signals Vercel accepted.
      log.warn(
        { signal, error: result.error, project_id: input.projectId },
        "vercel drain creation failed for signal",
      );
    }
  }

  // Every signal failed: there's nothing to ingest, so don't persist a bogus
  // "connected" install — roll back and surface the failure.
  if (Object.keys(drains).length === 0) {
    await rollback(drains);
    throw new VercelProvisioningError(
      "vercel connect: no drains were created",
      classifyDrainProvisioningFailure(drainErrors),
    );
  }

  // On a same-configuration reconnect, merge the prior ids under the new ones so
  // a signal whose recreate *failed* keeps its existing drain.
  const persistedDrains = sameConfiguration?.drains
    ? { ...sameConfiguration.drains, ...drains }
    : drains;

  // Cosmetic; never blocks the connect.
  const teamName = await fetchTeamName({
    teamId: input.token.teamId,
    accessToken: input.token.accessToken,
    fetchImpl: input.fetchImpl,
  });

  // Encrypt + persist as one unit. Encryption is inside the boundary too: if it
  // throws (e.g. a misconfigured secrets key) the drains/key/install created
  // above are still rolled back.
  try {
    const accessCipher = encryptIntegrationSecret(input.token.accessToken);
    const ingestCipher = encryptIntegrationSecret(ingestKey);
    const now = new Date();

    await db
      .insert(schema.vercelInstallations)
      .values({
        projectId: input.projectId,
        configurationId: input.token.installationId,
        teamId: input.token.teamId,
        teamName,
        accessTokenCiphertext: accessCipher.ciphertext,
        accessTokenNonce: accessCipher.nonce,
        accessTokenKeyVersion: accessCipher.keyVersion,
        apiKeyId,
        ingestKeyCiphertext: ingestCipher.ciphertext,
        ingestKeyNonce: ingestCipher.nonce,
        ingestKeyKeyVersion: ingestCipher.keyVersion,
        drains: persistedDrains,
        installedByUserId: input.userId,
      })
      .onConflictDoUpdate({
        target: [
          schema.vercelInstallations.projectId,
          schema.vercelInstallations.configurationId,
        ],
        set: {
          teamId: input.token.teamId,
          teamName,
          accessTokenCiphertext: accessCipher.ciphertext,
          accessTokenNonce: accessCipher.nonce,
          accessTokenKeyVersion: accessCipher.keyVersion,
          apiKeyId,
          ingestKeyCiphertext: ingestCipher.ciphertext,
          ingestKeyNonce: ingestCipher.nonce,
          ingestKeyKeyVersion: ingestCipher.keyVersion,
          drains: persistedDrains,
          installedByUserId: input.userId,
          revokedAt: null,
          updatedAt: now,
        },
      });
  } catch (e) {
    await rollback(drains);
    throw e;
  }

  // The install row is now committed and correct for this configuration. The
  // remaining cleanup is best-effort housekeeping: a failure here must NOT turn
  // an already-persisted connect into an error redirect, so we log and swallow.
  try {
    // Same-configuration reconnect: delete the prior drains we just replaced.
    // `staleDrainIds` only targets prior ids for signals that actually got a
    // replacement this run and never an id that's still live.
    if (sameConfiguration?.drains) {
      const stale = staleDrainIds(sameConfiguration.drains, drains);
      await deleteRemoteDrains({
        teamId: input.token.teamId,
        accessToken: input.token.accessToken,
        drains: stale,
        fetchImpl: input.fetchImpl,
      });
    }

    // Enforce a single active install per project: fully tear down any other
    // active install rows for this project that point at a different
    // configuration (delete their remote drains, delete their configuration,
    // revoke their ingest key, soft-revoke the row). A bare DB revoke would
    // leave the superseded install's drain streaming in with a still-valid key.
    const superseded = await db.query.vercelInstallations.findMany({
      where: and(
        eq(schema.vercelInstallations.projectId, input.projectId),
        ne(schema.vercelInstallations.configurationId, input.token.installationId),
        isNull(schema.vercelInstallations.revokedAt),
      ),
    });
    for (const row of superseded) {
      await teardownInstallation(row, { fetchImpl: input.fetchImpl });
    }
  } catch (e) {
    log.warn(
      { err: e, project_id: input.projectId },
      "vercel post-connect cleanup failed (connection persisted)",
    );
  }
}

export function mountVercelAuthed(
  app: Hono<{ Variables: Vars }>,
  deps: { config?: VercelConnectConfig | null; fetchImpl?: typeof fetch } = {},
): void {
  const config = deps.config !== undefined ? deps.config : vercelConfigFromEnv();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/projects/:projectId/vercel/installation", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ installed: false });
    return c.json(toPublic(row));
  });

  app.post("/api/projects/:projectId/vercel/install-url", async (c) => {
    if (!config || !stateSecret) {
      return c.json({ error: "vercel not configured" }, 503);
    }
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));

    const state = signState(
      { orgId: ctx.orgId, projectId: ctx.projectId, userId: ctx.userId },
      stateSecret,
    );
    const url = buildInstallUrl({ integrationSlug: config.integrationSlug, state });
    log.info({ org_id: ctx.orgId, project_id: ctx.projectId }, "vercel install url created");
    return c.json({ url });
  });

  app.post("/api/projects/:projectId/vercel/uninstall", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });

    // Delete the remote drains, delete the integration configuration, revoke
    // the ingest key, and soft-revoke the row so nothing keeps streaming after
    // "Disconnect".
    await teardownInstallation(row, { fetchImpl });
    return c.json({ ok: true });
  });
}
