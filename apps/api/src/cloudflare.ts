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
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
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
  getScriptObservability,
  isWorkerWired,
  listAccounts,
  listScripts,
  refreshAccessToken,
  revokeToken,
  signState,
  staleDestinationSlugs,
  unwireObservabilityDestinations,
  updateScriptObservability,
  verifyState,
  wireObservabilityDestinations,
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

// Access tokens are short-lived; refresh on demand when the stored one is
// within this margin of expiry. No background job — the offline-access grant
// gives us a long-lived refresh token, so we mint a fresh access token at the
// point we actually need it.
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** Decrypt the access token stored on an installation row. */
function decryptAccessToken(row: CloudflareInstallationRow): string {
  return decryptIntegrationSecret({
    ciphertext: row.accessTokenCiphertext,
    nonce: row.accessTokenNonce,
    keyVersion: row.accessTokenKeyVersion,
  });
}

/** Decrypt the refresh token stored on a row, or null when there isn't one. */
function decryptRefreshToken(row: CloudflareInstallationRow): string | null {
  return row.refreshTokenCiphertext && row.refreshTokenNonce
    ? decryptIntegrationSecret({
        ciphertext: row.refreshTokenCiphertext,
        nonce: row.refreshTokenNonce,
        keyVersion: row.refreshTokenKeyVersion ?? 1,
      })
    : null;
}

/** A known expiry that's still comfortably in the future — safe to use as-is. */
function tokenStillFresh(tokenExpiresAt: Date | null): boolean {
  const expiresAt = tokenExpiresAt?.getTime() ?? null;
  return expiresAt !== null && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS;
}

/**
 * A usable access token for an installation, refreshed on demand when the
 * stored one has expired (or is about to). This is how the connector stays
 * manageable after connect: the delegated access token lives ~16h, but the
 * offline-access grant hands us a long-lived refresh token, so any server-side
 * call (teardown today; reconcile/inspect later) renews right before use rather
 * than relying on a scheduled refresh.
 *
 * The refresh token ROTATES on every use, so two concurrent refreshes of the
 * same installation would each try to redeem the same token — the loser is
 * rejected and, under OAuth refresh-token reuse detection, that can revoke the
 * whole grant. So the refresh runs inside a per-installation Postgres advisory
 * lock: a second caller (a concurrent management op, or an overlapping
 * keep-alive pass) blocks on the lock, then re-reads and reuses the token the
 * winner just persisted instead of redeeming a stale one. The transaction is
 * held across the token HTTP call, which is fine for these rare, non-latency-
 * sensitive paths (uninstall / account switch).
 *
 * Falls back to the stored (possibly dead) token when there's nothing to
 * refresh with — a legacy install with no refresh token, or an unconfigured
 * OAuth client — so best-effort callers still get to try. Throws only when the
 * stored access token itself can't be decrypted.
 */
async function freshAccessToken(
  row: CloudflareInstallationRow,
  config: CloudflareConnectConfig | null,
  fetchImpl: typeof fetch,
): Promise<string> {
  const accessToken = decryptAccessToken(row);
  if (tokenStillFresh(row.tokenExpiresAt)) return accessToken;
  // Can't refresh without the OAuth client, or without a refresh token.
  if (!config || !(row.refreshTokenCiphertext && row.refreshTokenNonce)) return accessToken;

  return db.transaction(async (tx) => {
    // Serialize refresh for this installation across processes/requests so the
    // rotating token is redeemed exactly once. Namespaced two-key lock so it
    // can't collide with advisory locks elsewhere.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('cloudflare_installations'), hashtext(${row.id}))`,
    );
    const cur = await tx.query.cloudflareInstallations.findFirst({
      where: eq(schema.cloudflareInstallations.id, row.id),
    });
    if (!cur) return accessToken; // row vanished — fall back to our snapshot
    const curAccess = decryptAccessToken(cur);
    // Someone refreshed it while we waited for the lock — reuse their token.
    if (tokenStillFresh(cur.tokenExpiresAt)) return curAccess;
    const refreshToken = decryptRefreshToken(cur);
    if (!refreshToken) return curAccess;

    const refreshed = await refreshAccessToken({ config, refreshToken, fetchImpl });
    if (!refreshed.ok) {
      log.warn(
        { account_id: cur.accountId, error: refreshed.error },
        "cloudflare access token refresh failed; using stored token",
      );
      return curAccess;
    }

    const accessCipher = encryptIntegrationSecret(refreshed.accessToken);
    // Rotating refresh tokens: keep the replacement, falling back to the prior
    // one if the response didn't rotate it — losing it would strand the install.
    const refreshCipher = encryptIntegrationSecret(refreshed.refreshToken ?? refreshToken);
    const tokenExpiresAt =
      refreshed.expiresIn != null ? new Date(Date.now() + refreshed.expiresIn * 1000) : null;
    await tx
      .update(schema.cloudflareInstallations)
      .set({
        accessTokenCiphertext: accessCipher.ciphertext,
        accessTokenNonce: accessCipher.nonce,
        accessTokenKeyVersion: accessCipher.keyVersion,
        refreshTokenCiphertext: refreshCipher.ciphertext,
        refreshTokenNonce: refreshCipher.nonce,
        refreshTokenKeyVersion: refreshCipher.keyVersion,
        tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.cloudflareInstallations.id, cur.id));
    return refreshed.accessToken;
  });
}

/**
 * Fully tear down one installation row: delete its remote destinations, revoke
 * its delegated OAuth token, revoke the ingest key its destinations authenticate
 * with, and soft-revoke the row. Each remote step is best-effort (the grant may
 * be gone); the ingest-key revoke is the backstop that actually stops telemetry
 * being accepted at our intake. Shared by uninstall and account-switch supersede.
 */
async function teardownInstallation(
  row: CloudflareInstallationRow,
  deps: { config: CloudflareConnectConfig | null; fetchImpl: typeof fetch },
): Promise<void> {
  let accessToken: string | null = null;
  try {
    // Refresh first so the remote cleanup actually runs: by uninstall time the
    // original ~16h access token is almost always dead, but the refresh token
    // lets us mint a live one and delete the destinations cleanly.
    accessToken = await freshAccessToken(row, deps.config, deps.fetchImpl);
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

/**
 * Wire the account's Workers to our destinations. Creating a destination only
 * makes telemetry flow once each Worker's own `observability` config enables the
 * signal and lists the destination, so we read every Worker's settings and merge
 * our slugs in (additive + idempotent). Best-effort and per-Worker isolated: a
 * Worker we can't update is logged and skipped, never failing the connect. Only
 * traces/logs are wired — Workers Observability has no per-Worker metrics signal.
 */
async function wireAccountWorkers(input: {
  accountId: string;
  accessToken: string;
  destinations: Record<string, string>;
  fetchImpl: typeof fetch;
}): Promise<{ scripts: number; wired: number }> {
  const slugs = { traces: input.destinations.traces, logs: input.destinations.logs };
  if (!slugs.traces && !slugs.logs) return { scripts: 0, wired: 0 };
  const scripts = await listScripts(input.accountId, input.accessToken, input.fetchImpl);
  let wired = 0;
  for (const script of scripts) {
    try {
      const current = await getScriptObservability({
        accountId: input.accountId,
        script,
        accessToken: input.accessToken,
        fetchImpl: input.fetchImpl,
      });
      const next = wireObservabilityDestinations(current, slugs);
      if (!next) continue; // already wired
      const res = await updateScriptObservability({
        accountId: input.accountId,
        script,
        observability: next,
        accessToken: input.accessToken,
        fetchImpl: input.fetchImpl,
      });
      if (res.ok) wired += 1;
      else
        log.warn({ script, error: res.error }, "cloudflare: failed to wire worker observability");
    } catch (e) {
      log.warn({ err: e, script }, "cloudflare: failed to wire worker observability");
    }
  }
  log.info(
    { account_id: input.accountId, scripts: scripts.length, wired },
    "cloudflare: wired worker observability to destinations",
  );
  return { scripts: scripts.length, wired };
}

/** Our destination slugs for a row, in the shape the wire/unwire helpers take. */
function slugsForRow(row: CloudflareInstallationRow): { traces?: string; logs?: string } {
  return { traces: row.destinations?.traces, logs: row.destinations?.logs };
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
      // We exchanged the code but won't use the grant — revoke it so the token
      // doesn't stay live at Cloudflare after we abort. Best-effort.
      await revokeToken({ config, token: token.accessToken, fetchImpl });
      return c.redirect(`${webOrigin}/?cloudflare=error`, 302);
    }
    // Cloudflare's OAuth consent is account-scoped — the user picks which account
    // to grant — so the granted token normally resolves to a single account. If a
    // token ever resolves to more than one we can't know which the user meant, so
    // bail rather than silently streaming telemetry from an arbitrary account.
    if (accounts.length > 1) {
      log.error(
        { count: accounts.length, project_id: decoded.projectId },
        "cloudflare connect: token grants multiple accounts; refusing to guess",
      );
      await revokeToken({ config, token: token.accessToken, fetchImpl });
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

  // Undo everything this run created that isn't safely persisted to an install
  // row: the new remote destinations (minus any slug the prior same-account row
  // still owns — an upsert-by-name create that returned the same slug is the live
  // one that row depends on), a freshly minted ingest key, and the just-exchanged
  // OAuth grant. Called on *every* pre-commit failure path so a connect never
  // leaves an orphaned destination/key/grant behind. Best-effort throughout.
  const rollback = async (created: Record<string, string>): Promise<void> => {
    const priorSlugs = new Set(Object.values(sameAccount?.destinations ?? {}));
    const orphaned = Object.fromEntries(
      Object.entries(created).filter(([, slug]) => !priorSlugs.has(slug)),
    );
    await deleteRemoteDestinations({
      accountId: input.account.id,
      accessToken: input.token.accessToken,
      destinations: orphaned,
      fetchImpl: input.fetchImpl,
    });
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
  };

  // Create the new destinations first; we only tear down any prior same-account
  // destinations *after* a replacement lands (see below). Deleting up front would
  // leave the project "connected" with zero live destinations if creation fails.
  const destinations: Record<string, string> = {};
  for (const signal of CLOUDFLARE_SIGNALS) {
    const result = await createDestination({
      accountId: input.account.id,
      accessToken: input.token.accessToken,
      payload: buildDestinationPayload({
        signal,
        intakeBaseUrl: input.config.intakeBaseUrl,
        ingestKey,
        projectId: input.projectId,
      }),
      fetchImpl: input.fetchImpl,
    });
    // Only record a destination we can actually manage later: a success that
    // carries a slug. A slug-less "success" can't be deleted on reconnect/
    // uninstall, so treat it as a failure (skip it) rather than store an empty
    // slug we'd later have to skip during cleanup.
    if (result.ok && result.slug) {
      destinations[signal] = result.slug;
    } else {
      // Don't abort the whole connect on one signal — log and continue so the
      // user still gets the signals Cloudflare accepted.
      log.warn(
        {
          signal,
          error: result.ok ? "missing slug" : result.error,
          project_id: input.projectId,
        },
        "cloudflare destination creation failed for signal",
      );
    }
  }

  // Every signal failed: there's nothing to ingest, so don't persist a bogus
  // "connected" install — roll back and surface the failure.
  if (Object.keys(destinations).length === 0) {
    await rollback(destinations);
    throw new Error("cloudflare connect: no telemetry destinations were created");
  }

  // On a same-account reconnect, merge the prior slugs under the new ones so a
  // signal whose recreate *failed* keeps its existing destination. This is the
  // set we both persist and wire Workers to, so Workers point at retained slugs
  // (not just the ones created this run).
  const persistedDestinations = sameAccount?.destinations
    ? { ...sameAccount.destinations, ...destinations }
    : destinations;

  // Encrypt + persist as one unit. Encryption is inside the boundary too: if it
  // throws (e.g. a misconfigured secrets key) the destinations/key/grant created
  // above are still rolled back.
  try {
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
        destinations: persistedDestinations,
        installedByUserId: input.userId,
      })
      .onConflictDoUpdate({
        target: [
          schema.cloudflareInstallations.projectId,
          schema.cloudflareInstallations.accountId,
        ],
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
          destinations: persistedDestinations,
          installedByUserId: input.userId,
          revokedAt: null,
          updatedAt: now,
        },
      });
  } catch (e) {
    await rollback(destinations);
    throw e;
  }

  // The install row is now committed and correct for this account. The remaining
  // cleanup is best-effort housekeeping: a failure here must NOT turn an
  // already-persisted connect into an error redirect, so we log and swallow.
  try {
    // Same-account reconnect: delete the prior destinations we just replaced.
    // `staleDestinationSlugs` only targets prior slugs for signals that actually
    // got a replacement this run (a signal whose recreate failed keeps its old
    // destination, which we merged back into the row above) and never a slug
    // that's still live (an upsert-by-name create that returned the same slug).
    if (sameAccount?.destinations) {
      const staleSlugs = staleDestinationSlugs(sameAccount.destinations, destinations);
      await deleteRemoteDestinations({
        accountId: input.account.id,
        accessToken: input.token.accessToken,
        destinations: staleSlugs,
        fetchImpl: input.fetchImpl,
      });
    }

    // Enforce a single active Cloudflare account per project: fully tear down any
    // other active install rows for this project that point at a different
    // account (delete their remote destinations, revoke their OAuth token +
    // ingest key, soft-revoke the row). A bare DB revoke would leave the
    // superseded account's destinations streaming in with a still-valid key.
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

    // Wire the account's Workers to the destinations — without this the
    // destinations exist but no Worker exports to them, so no telemetry ever
    // flows (the connect looks done but the project stays empty). Use the merged
    // set so Workers are wired to slugs we retained from a prior connect too, not
    // just the ones created this run.
    await wireAccountWorkers({
      accountId: input.account.id,
      accessToken: input.token.accessToken,
      destinations: persistedDestinations,
      fetchImpl: input.fetchImpl,
    });
  } catch (e) {
    log.warn(
      { err: e, project_id: input.projectId },
      "cloudflare post-connect cleanup failed (connection persisted)",
    );
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

  // Obtain a live access token for a management call, or throw an HTTPException
  // the routes surface as "reconnect needed" — the shared refresh-on-use path.
  async function accessTokenFor(row: CloudflareInstallationRow): Promise<string> {
    try {
      return await freshAccessToken(row, config, fetchImpl);
    } catch (e) {
      log.warn({ err: e, account_id: row.accountId }, "cloudflare: could not obtain access token");
      throw new HTTPException(502, { message: "cloudflare token unavailable; reconnect" });
    }
  }

  // List the account's Worker scripts with whether each currently exports to our
  // destinations. This is the surface that makes a dark/unwired worker visible.
  app.get("/api/projects/:projectId/cloudflare/workers", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ error: "not connected" }, 404);
    const slugs = slugsForRow(row);
    const accessToken = await accessTokenFor(row);
    const scripts = await listScripts(row.accountId, accessToken, fetchImpl);
    const workers = await Promise.all(
      scripts.map(async (script) => {
        try {
          const obs = await getScriptObservability({
            accountId: row.accountId,
            script,
            accessToken,
            fetchImpl,
          });
          return {
            name: script,
            wired: isWorkerWired(obs, slugs),
            observabilityEnabled: obs?.enabled === true,
          };
        } catch (e) {
          // A single unreadable worker shouldn't blank the list — show it as
          // unwired so the user can still try to wire it.
          log.warn({ err: e, script }, "cloudflare: worker observability read failed");
          return { name: script, wired: false, observabilityEnabled: false };
        }
      }),
    );
    workers.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ workers });
  });

  // Wire every current worker in the account to our destinations (one-shot).
  app.post("/api/projects/:projectId/cloudflare/workers/wire-all", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ error: "not connected" }, 404);
    const accessToken = await accessTokenFor(row);
    const result = await wireAccountWorkers({
      accountId: row.accountId,
      accessToken,
      destinations: row.destinations ?? {},
      fetchImpl,
    });
    return c.json({ ok: true, ...result });
  });

  // Wire / unwire one worker. Both read the worker's current observability,
  // apply the additive (wire) or subtractive (unwire) transform, and PATCH only
  // when it actually changes.
  app.post("/api/projects/:projectId/cloudflare/workers/:script/wire", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const script = c.req.param("script");
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ error: "not connected" }, 404);
    const slugs = slugsForRow(row);
    if (!slugs.traces && !slugs.logs) {
      return c.json({ error: "no destinations provisioned" }, 400);
    }
    const accessToken = await accessTokenFor(row);
    try {
      const obs = await getScriptObservability({
        accountId: row.accountId,
        script,
        accessToken,
        fetchImpl,
      });
      const next = wireObservabilityDestinations(obs, slugs);
      if (next) {
        const res = await updateScriptObservability({
          accountId: row.accountId,
          script,
          observability: next,
          accessToken,
          fetchImpl,
        });
        if (!res.ok) return c.json({ error: res.error ?? "wire failed" }, 502);
      }
      return c.json({ ok: true, wired: true });
    } catch (e) {
      log.warn({ err: e, script }, "cloudflare: wire worker failed");
      return c.json({ error: "wire failed" }, 502);
    }
  });

  app.post("/api/projects/:projectId/cloudflare/workers/:script/unwire", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const script = c.req.param("script");
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ error: "not connected" }, 404);
    const slugs = slugsForRow(row);
    const accessToken = await accessTokenFor(row);
    try {
      const obs = await getScriptObservability({
        accountId: row.accountId,
        script,
        accessToken,
        fetchImpl,
      });
      const next = unwireObservabilityDestinations(obs, slugs);
      if (next) {
        const res = await updateScriptObservability({
          accountId: row.accountId,
          script,
          observability: next,
          accessToken,
          fetchImpl,
        });
        if (!res.ok) return c.json({ error: res.error ?? "unwire failed" }, 502);
      }
      return c.json({ ok: true, wired: false });
    } catch (e) {
      log.warn({ err: e, script }, "cloudflare: unwire worker failed");
      return c.json({ error: "unwire failed" }, 502);
    }
  });
}
