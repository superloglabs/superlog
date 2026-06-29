// Cloudflare integration routes: a Slack-style OAuth "Connect Cloudflare" button.
//
// Flow:
//   1. (authed)  POST /api/cloudflare/install-url  → signed-state authorize URL
//   2. user consents on dash.cloudflare.com
//   3. (public)  GET  /cloudflare/oauth/callback   → exchange code, then use the
//      granted token to create Workers Observability telemetry destinations that
//      export OTLP traces/logs/metrics to our intake with a project ingest key.
//   4. (authed)  GET  /api/cloudflare/installation  → connection status
//                POST /api/cloudflare/uninstall      → revoke + forget
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
import { and, eq, isNull } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  CLOUDFLARE_SIGNALS,
  type CloudflareConnectConfig,
  buildAuthorizeUrl,
  buildDestinationPayload,
  cloudflareConfigFromEnv,
  createDestination,
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

async function findInstallation(projectId: string) {
  return db.query.cloudflareInstallations.findFirst({
    where: and(
      eq(schema.cloudflareInstallations.projectId, projectId),
      isNull(schema.cloudflareInstallations.revokedAt),
    ),
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
): Promise<{ ingestKey: string; apiKeyId: string }> {
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
      return { ingestKey, apiKeyId: existing.apiKeyId };
    }
  }
  const minted = await mintApiKey({ projectId, name: "Cloudflare Workers OTLP" });
  return { ingestKey: minted.plaintext, apiKeyId: minted.id };
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
  const { ingestKey, apiKeyId } = await ensureIngestKey(input.projectId, existing);

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
}

export function mountCloudflareAuthed(
  app: Hono<{ Variables: Vars }>,
  deps: { config?: CloudflareConnectConfig | null; fetchImpl?: typeof fetch } = {},
): void {
  const config = deps.config !== undefined ? deps.config : cloudflareConfigFromEnv();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/cloudflare/installation", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ installed: false });
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ installed: false });
    return c.json(toPublic(row));
  });

  app.post("/api/cloudflare/install-url", async (c) => {
    if (!config || !stateSecret) {
      return c.json({ error: "cloudflare not configured" }, 503);
    }
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);

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

  app.post("/api/cloudflare/uninstall", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });

    // Best-effort remote revoke of the delegated token; never block on failure.
    if (config) {
      try {
        const accessToken = decryptIntegrationSecret({
          ciphertext: row.accessTokenCiphertext,
          nonce: row.accessTokenNonce,
          keyVersion: row.accessTokenKeyVersion,
        });
        await revokeToken({ config, token: accessToken, fetchImpl });
      } catch (e) {
        log.warn({ err: e }, "cloudflare token revoke failed");
      }
    }

    await db
      .update(schema.cloudflareInstallations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.cloudflareInstallations.id, row.id));
    return c.json({ ok: true });
  });
}
