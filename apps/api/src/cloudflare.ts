// Cloudflare integration routes: a Slack-style OAuth "Connect Cloudflare" button.
//
// Flow (the authed routes are project-scoped — installs are per project, so the
// project must be explicit in the path rather than inferred from the caller's
// "active" project):
//   1. (authed)  POST /api/projects/:projectId/cloudflare/install-url
//                → signed-state authorize URL (state carries org/project/user)
//   2. user consents on dash.cloudflare.com
//   3. (public)  GET  /cloudflare/oauth/callback   → exchange code, then use the
//      granted token to create Workers Observability telemetry destinations that
//      export OTLP traces/logs/metrics to our intake with a project ingest key.
//   4. (authed)  GET  /api/projects/:projectId/cloudflare/installation → status
//                POST /api/projects/:projectId/cloudflare/uninstall → revoke
//
// The callback lives outside /api/* so it isn't behind the session middleware —
// it's authenticated by the HMAC-signed `state` (see cloudflare-service.ts),
// exactly like the Slack connector's /slack/oauth/callback.

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
import {
  CLOUDFLARE_SIGNALS,
  type CloudflareConnectConfig,
  buildAuthorizeUrl,
  buildDestinationPayload,
  cloudflareConfigFromEnv,
  createDestination,
  deleteDestination,
  exchangeCodeForToken,
  listAccounts,
  revokeToken,
  signState,
  verifyState,
} from "./cloudflare-service.js";
import { logger } from "./logger.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "cloudflare" });

type Vars = { userId: string; orgId: string | null };

type CloudflareInstallationRow = typeof schema.cloudflareInstallations.$inferSelect;

/** Public shape — never leaks token ciphertext. */
function toPublic(row: CloudflareInstallationRow) {
  return {
    installed: true,
    accountId: row.accountId,
    accountName: row.accountName,
    scope: row.scope,
    destinations: row.destinations ?? {},
    installedAt: row.createdAt,
  };
}

// Resolve the project the request targets from the path param and confirm the
// caller's active org owns it. Cloudflare installs are per-project (the table is
// keyed by (project, account)), so the project must be explicit — inferring the
// user's "active" project here would connect/disconnect the wrong project when
// Settings is viewing a different one.
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

// The single active install for a project. We enforce one active Cloudflare
// account per project at provision time (see provisionInstallation), so this is
// unambiguous; `orderBy` is belt-and-suspenders for any legacy multi-row state.
async function findInstallation(projectId: string) {
  return db.query.cloudflareInstallations.findFirst({
    where: and(
      eq(schema.cloudflareInstallations.projectId, projectId),
      isNull(schema.cloudflareInstallations.revokedAt),
    ),
    orderBy: desc(schema.cloudflareInstallations.createdAt),
  });
}

/**
 * Get (or mint) the ingest key the destinations authenticate with. Reuses the
 * installation's stored key when it's still live so a reconnect doesn't orphan a
 * working key; mints a fresh one otherwise.
 */
async function ensureIngestKey(
  projectId: string,
  existing: CloudflareInstallationRow | null,
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
  const minted = await mintApiKey({ projectId, name: "Cloudflare Workers OTLP" });
  return { ingestKey: minted.plaintext, apiKeyId: minted.id, minted: true };
}

/**
 * Best-effort delete the Workers Observability destinations we created under one
 * account (by slug). Used both when re-provisioning the same account (so the new
 * destinations don't stack on top of the old ones) and when tearing down a
 * superseded account. Empty slugs (a create that returned no slug) are skipped.
 */
async function deleteRemoteDestinations(input: {
  accountId: string;
  accessToken: string;
  destinations: Record<string, string> | null | undefined;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const slugs = Object.values(input.destinations ?? {}).filter((s) => s.length > 0);
  for (const slug of slugs) {
    const res = await deleteDestination({
      accountId: input.accountId,
      accessToken: input.accessToken,
      slug,
      fetchImpl: input.fetchImpl,
    });
    if (!res.ok) {
      log.warn({ slug, account_id: input.accountId }, "cloudflare destination delete failed");
    }
  }
}

/**
 * Fully tear down one installation row: delete its remote destinations, revoke
 * its delegated OAuth token, revoke the ingest key its destinations authenticate
 * with, and soft-revoke the row. Each remote step is best-effort (tokens may be
 * expired); the ingest-key revoke is the backstop that actually stops telemetry
 * being accepted at our intake. Shared by uninstall and account-switch supersede.
 */
async function teardownInstallation(
  row: CloudflareInstallationRow,
  deps: { config: CloudflareConnectConfig | null; fetchImpl: typeof fetch },
): Promise<void> {
  let accessToken: string | null = null;
  try {
    accessToken = decryptIntegrationSecret({
      ciphertext: row.accessTokenCiphertext,
      nonce: row.accessTokenNonce,
      keyVersion: row.accessTokenKeyVersion,
    });
  } catch (e) {
    log.warn({ err: e, account_id: row.accountId }, "cloudflare access token decrypt failed");
  }

  if (accessToken) {
    await deleteRemoteDestinations({
      accountId: row.accountId,
      accessToken,
      destinations: row.destinations,
      fetchImpl: deps.fetchImpl,
    });
    if (deps.config) {
      try {
        await revokeToken({ config: deps.config, token: accessToken, fetchImpl: deps.fetchImpl });
      } catch (e) {
        log.warn({ err: e }, "cloudflare token revoke failed");
      }
    }
  }

  // Revoke the ingest API key the destinations authenticate with. Without this
  // any destination we couldn't delete remotely keeps streaming into the
  // project — the OAuth revoke only stops us from managing the account.
  if (row.apiKeyId) {
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.apiKeyId));
  }

  await db
    .update(schema.cloudflareInstallations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.cloudflareInstallations.id, row.id));
}

export function mountCloudflarePublic(
  app: Hono<{ Variables: Vars }>,
  deps: { config?: CloudflareConnectConfig | null; fetchImpl?: typeof fetch } = {},
): void {
  const config = deps.config !== undefined ? deps.config : cloudflareConfigFromEnv();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  if (!config) {
    log.warn("CLOUDFLARE_CLIENT_ID/SECRET/OTLP_INTAKE_URL not set — Cloudflare connect disabled");
  }

  app.get("/cloudflare/oauth/callback", async (c) => {
    if (!config || !stateSecret) {
      return c.json({ error: "cloudflare not configured" }, 503);
    }
    const err = c.req.query("error");
    if (err) {
      log.warn({ error: err }, "cloudflare oauth callback denied");
      return c.redirect(`${webOrigin}/?cloudflare=denied`, 302);
    }
    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    if (!code) return c.redirect(`${webOrigin}/?cloudflare=error`, 302);

    const decoded = verifyState(state, stateSecret);
    if (!decoded) {
      log.warn("cloudflare oauth callback rejected: invalid or expired state");
      return c.redirect(`${webOrigin}/?cloudflare=error`, 302);
    }

    const token = await exchangeCodeForToken({ config, code, fetchImpl });
    if (!token.ok) {
      log.error({ error: token.error }, "cloudflare token exchange failed");
      return c.redirect(`${webOrigin}/?cloudflare=error`, 302);
    }

    const accounts = await listAccounts(token.accessToken, fetchImpl);
    const account = accounts[0];
    if (!account) {
      log.error("cloudflare connect: no accessible account on the granted token");
      return c.redirect(`${webOrigin}/?cloudflare=error`, 302);
    }

    try {
      await provisionInstallation({
        projectId: decoded.projectId,
        userId: decoded.userId,
        account,
        token,
        config,
        fetchImpl,
      });
    } catch (e) {
      // Provisioning throws when it can't produce a usable connection (e.g. no
      // destination could be created — we never persist a connection that can't
      // receive telemetry, which would unlock onboarding as "connected" with
      // nothing flowing). Surface as an error so the flow can reset rather than
      // spin in the waiting state.
      log.error({ err: e, project_id: decoded.projectId }, "cloudflare provisioning failed");
      return c.redirect(`${webOrigin}/?cloudflare=error`, 302);
    }

    log.info(
      { project_id: decoded.projectId, account_id: account.id },
      "cloudflare connected and destinations provisioned",
    );
    return c.redirect(`${webOrigin}/?cloudflare=installed`, 302);
  });
}

/**
 * Exchange complete → create the OTLP destinations and persist the install.
 * Factored out of the route so the orchestration is one readable unit.
 */
async function provisionInstallation(input: {
  projectId: string;
  userId: string | null;
  account: { id: string; name: string };
  token: {
    ok: true;
    accessToken: string;
    refreshToken: string | null;
    expiresIn: number | null;
    scope: string | null;
  };
  config: CloudflareConnectConfig;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const existing = (await findInstallation(input.projectId)) ?? null;
  // Only reuse the stored ingest key when re-provisioning the *same* account; an
  // account switch must get a fresh key so the superseded account's key can be
  // revoked independently (otherwise both accounts share one live key).
  const sameAccount = existing?.accountId === input.account.id ? existing : null;
  const { ingestKey, apiKeyId, minted } = await ensureIngestKey(input.projectId, sameAccount);

  // Re-provisioning the same account: delete the destinations we created last
  // time before making new ones. They authenticate with the same ingest key, so
  // leaving them in place would double every OTLP export on each reconnect.
  if (sameAccount?.destinations) {
    await deleteRemoteDestinations({
      accountId: input.account.id,
      accessToken: input.token.accessToken,
      destinations: sameAccount.destinations,
      fetchImpl: input.fetchImpl,
    });
  }

  const destinations: Record<string, string> = {};
  for (const signal of CLOUDFLARE_SIGNALS) {
    const result = await createDestination({
      accountId: input.account.id,
      accessToken: input.token.accessToken,
      payload: buildDestinationPayload({
        signal,
        intakeBaseUrl: input.config.intakeBaseUrl,
        ingestKey,
      }),
      fetchImpl: input.fetchImpl,
    });
    if (result.ok) {
      destinations[signal] = result.slug ?? "";
    } else {
      // Don't abort the whole connect on one signal — log and continue so the
      // user still gets the signals Cloudflare accepted.
      log.warn(
        { signal, error: result.error, project_id: input.projectId },
        "cloudflare destination creation failed for signal",
      );
    }
  }

  // Every signal failed: there's nothing to ingest, so don't persist a bogus
  // "connected" install. Clean up the freshly minted ingest key (if we minted
  // one this run) and the now-unstored OAuth token, then surface the failure.
  if (Object.keys(destinations).length === 0) {
    if (minted) {
      await db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(schema.apiKeys.id, apiKeyId));
    }
    await revokeToken({
      config: input.config,
      token: input.token.accessToken,
      fetchImpl: input.fetchImpl,
    });
    throw new Error("cloudflare connect: no telemetry destinations were created");
  }

  const accessCipher = encryptIntegrationSecret(input.token.accessToken);
  const refreshCipher = input.token.refreshToken
    ? encryptIntegrationSecret(input.token.refreshToken)
    : null;
  const ingestCipher = encryptIntegrationSecret(ingestKey);
  const tokenExpiresAt =
    input.token.expiresIn != null ? new Date(Date.now() + input.token.expiresIn * 1000) : null;
  const now = new Date();

  await db
    .insert(schema.cloudflareInstallations)
    .values({
      projectId: input.projectId,
      accountId: input.account.id,
      accountName: input.account.name || null,
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
      destinations,
      installedByUserId: input.userId,
    })
    .onConflictDoUpdate({
      target: [schema.cloudflareInstallations.projectId, schema.cloudflareInstallations.accountId],
      set: {
        accountName: input.account.name || null,
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
        destinations,
        installedByUserId: input.userId,
        revokedAt: null,
        updatedAt: now,
      },
    });

  // Enforce a single active Cloudflare account per project: fully tear down any
  // other active install rows for this project that point at a different account
  // (delete their remote destinations, revoke their OAuth token + ingest key,
  // soft-revoke the row). A bare DB revoke would leave the superseded account's
  // destinations streaming into the project with a still-valid key.
  const superseded = await db.query.cloudflareInstallations.findMany({
    where: and(
      eq(schema.cloudflareInstallations.projectId, input.projectId),
      ne(schema.cloudflareInstallations.accountId, input.account.id),
      isNull(schema.cloudflareInstallations.revokedAt),
    ),
  });
  for (const row of superseded) {
    await teardownInstallation(row, { config: input.config, fetchImpl: input.fetchImpl });
  }
}

export function mountCloudflareAuthed(
  app: Hono<{ Variables: Vars }>,
  deps: { config?: CloudflareConnectConfig | null; fetchImpl?: typeof fetch } = {},
): void {
  const config = deps.config !== undefined ? deps.config : cloudflareConfigFromEnv();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/projects/:projectId/cloudflare/installation", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ installed: false });
    return c.json(toPublic(row));
  });

  app.post("/api/projects/:projectId/cloudflare/install-url", async (c) => {
    if (!config || !stateSecret) {
      return c.json({ error: "cloudflare not configured" }, 503);
    }
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));

    const state = signState(
      { orgId: ctx.orgId, projectId: ctx.projectId, userId: ctx.userId },
      stateSecret,
    );
    const url = buildAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
      state,
    });
    log.info({ org_id: ctx.orgId, project_id: ctx.projectId }, "cloudflare install url created");
    return c.json({ url });
  });

  app.post("/api/projects/:projectId/cloudflare/uninstall", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });

    // Delete the remote destinations, revoke the OAuth token + ingest key, and
    // soft-revoke the row so nothing keeps streaming after "Disconnect".
    await teardownInstallation(row, { config, fetchImpl });
    return c.json({ ok: true });
  });
}
