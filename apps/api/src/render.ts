// Render integration routes: a "Connect Render" flow built on a user-created
// API key. Render has no third-party OAuth, so unlike the Railway connector
// there is no consent redirect and no public callback — the user pastes an API
// key (Render dashboard → Account settings → API Keys), we list the workspaces
// the key can see, the user picks one, and the key is stored encrypted. Like
// Railway there is nothing to provision on Render's side: a worker-side puller
// (apps/worker) reads logs and metrics from the chosen workspace via Render's
// REST API and forwards them to our intake with the ingest key minted here.
//
// Flow (all authed; no public routes):
//   1. POST /api/projects/:projectId/render/owners   { apiKey }
//      → validates the key, returns the workspaces it can see
//   2. POST /api/projects/:projectId/render/connect  { apiKey, ownerId }
//      → snapshots the workspace's services, mints the ingest key, persists
//   3. GET  /api/projects/:projectId/render/installation → status
//      POST /api/projects/:projectId/render/uninstall    → remove
//
// A Render API key grants access to every workspace its creator belongs to —
// there are no read-only or scoped keys — so the key is treated like any other
// integration secret: encrypted at rest, never logged, only ever used for
// reads scoped to the workspace the user picked.

import {
  db,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  mintApiKey,
  schema,
} from "@superlog/db";
import { fetchOwners, fetchServices } from "@superlog/render";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "render" });

type Vars = { userId: string; orgId: string | null };

type RenderInstallationRow = typeof schema.renderInstallations.$inferSelect;

/** Public shape — never leaks the API key ciphertext. */
function toPublic(row: RenderInstallationRow) {
  return {
    installed: true,
    ownerId: row.renderOwnerId,
    ownerName: row.renderOwnerName,
    services: row.services ?? [],
    installedAt: row.createdAt,
  };
}

// Resolve the project the request targets from the path param and confirm the
// caller's active org owns it (same discipline as the other connectors —
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
  return db.query.renderInstallations.findFirst({
    where: and(
      eq(schema.renderInstallations.projectId, projectId),
      isNull(schema.renderInstallations.revokedAt),
    ),
    orderBy: desc(schema.renderInstallations.createdAt),
  });
}

/**
 * Get (or mint) the ingest key the puller forwards telemetry with. Reuses the
 * installation's stored key when it's still live so a re-connect doesn't
 * orphan a working key; mints a fresh one otherwise.
 */
async function ensureIngestKey(
  projectId: string,
  existing: RenderInstallationRow | null,
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
  const minted = await mintApiKey({ projectId, name: "Render puller" });
  return { ingestKey: minted.plaintext, apiKeyId: minted.id, minted: true };
}

/**
 * Tear down one installation row. There is nothing to delete on Render's side
 * (the user's API key stays theirs — they can revoke it from Render's
 * dashboard); revoking the ingest key stops our intake accepting anything the
 * puller would forward, and the soft-revoke stops the puller reading Render at
 * all. The stored Render key ciphertext stays on the revoked row, unreadable
 * without AGENT_SECRETS_KEY and unused once revoked.
 */
type DbExecutor = Pick<typeof db, "update">;

async function teardownInstallation(
  row: RenderInstallationRow,
  executor: DbExecutor = db,
): Promise<void> {
  if (row.apiKeyId) {
    await executor
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.apiKeyId));
  }
  await executor
    .update(schema.renderInstallations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.renderInstallations.id, row.id));
}

// The connect/owners request body: the key the user pasted. Never logged.
function readApiKey(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const key = (body as { apiKey?: unknown }).apiKey;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

export function mountRenderAuthed(
  app: Hono<{ Variables: Vars }>,
  deps: { fetchImpl?: typeof fetch } = {},
): void {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Storing the pasted key requires the at-rest encryption key; without it the
  // connect flow could never complete, so the routes self-disable (and
  // system-capabilities hides the connector tile).
  const secretsConfigured = () => !!process.env.AGENT_SECRETS_KEY;

  app.get("/api/projects/:projectId/render/installation", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ installed: false });
    return c.json(toPublic(row));
  });

  // Validate a pasted key and list the workspaces it can see — the connect
  // dialog's picker. The key is used for one listing call and discarded.
  app.post("/api/projects/:projectId/render/owners", async (c) => {
    if (!secretsConfigured()) return c.json({ error: "render not configured" }, 503);
    await requireProjectAccess(c, c.req.param("projectId"));
    const apiKey = readApiKey(await c.req.json().catch(() => null));
    if (!apiKey) return c.json({ error: "missing apiKey" }, 400);

    const owners = await fetchOwners({ apiKey, fetchImpl });
    if (!owners.ok) {
      if (owners.unauthorized) return c.json({ error: "invalid_key" }, 400);
      log.warn({ error: owners.error }, "render owners lookup failed");
      return c.json({ error: "render_unavailable" }, 502);
    }
    return c.json({
      owners: owners.owners.map((o) => ({
        id: o.id,
        name: o.name,
        email: o.email,
        type: o.type,
      })),
    });
  });

  app.post("/api/projects/:projectId/render/connect", async (c) => {
    if (!secretsConfigured()) return c.json({ error: "render not configured" }, 503);
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const body = (await c.req.json().catch(() => null)) as { ownerId?: unknown } | null;
    const apiKey = readApiKey(body);
    const ownerId = typeof body?.ownerId === "string" && body.ownerId ? body.ownerId : null;
    if (!apiKey || !ownerId) return c.json({ error: "missing apiKey or ownerId" }, 400);

    // Re-validate the key server-side and confirm it can actually see the
    // chosen workspace — the picker response is client input by the time it
    // comes back here.
    const owners = await fetchOwners({ apiKey, fetchImpl });
    if (!owners.ok) {
      if (owners.unauthorized) return c.json({ error: "invalid_key" }, 400);
      log.warn({ error: owners.error }, "render owners lookup failed");
      return c.json({ error: "render_unavailable" }, 502);
    }
    const owner = owners.owners.find((o) => o.id === ownerId);
    if (!owner) return c.json({ error: "unknown_owner" }, 400);

    // Snapshot the workspace's services so the UI can show what the pull
    // covers. An empty workspace still connects — services may come later; the
    // puller refreshes the snapshot every pass.
    const services = await fetchServices({ apiKey, ownerId, fetchImpl });
    if (!services.ok) {
      log.warn({ error: services.error }, "render services lookup failed");
      return c.json({ error: "render_unavailable" }, 502);
    }

    const existing = await db.query.renderInstallations.findFirst({
      where: and(
        eq(schema.renderInstallations.projectId, ctx.projectId),
        eq(schema.renderInstallations.renderOwnerId, ownerId),
        isNull(schema.renderInstallations.revokedAt),
      ),
    });
    const { ingestKey, apiKeyId, minted } = await ensureIngestKey(ctx.projectId, existing ?? null);

    try {
      const keyCipher = encryptIntegrationSecret(apiKey);
      const ingestCipher = encryptIntegrationSecret(ingestKey);
      const now = new Date();
      const servicesSnapshot = services.services.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        region: s.region,
        suspended: s.suspended,
      }));

      // One transaction for the upsert AND the supersede of other active rows,
      // so "a project has exactly one active install" holds even across a
      // crash between the two writes. The project-scoped advisory lock
      // serializes concurrent connects for *different* workspaces — without
      // it, two simultaneous transactions can each miss the other's
      // uncommitted row in the supersede SELECT and both installs stay
      // active. Released automatically at commit/rollback.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`render_install:${ctx.projectId}`}))`,
        );
        await tx
          .insert(schema.renderInstallations)
          .values({
            projectId: ctx.projectId,
            renderOwnerId: owner.id,
            renderOwnerName: owner.name,
            services: servicesSnapshot,
            renderApiKeyCiphertext: keyCipher.ciphertext,
            renderApiKeyNonce: keyCipher.nonce,
            renderApiKeyKeyVersion: keyCipher.keyVersion,
            apiKeyId,
            ingestKeyCiphertext: ingestCipher.ciphertext,
            ingestKeyNonce: ingestCipher.nonce,
            ingestKeyKeyVersion: ingestCipher.keyVersion,
            installedByUserId: ctx.userId,
          })
          .onConflictDoUpdate({
            target: [
              schema.renderInstallations.projectId,
              schema.renderInstallations.renderOwnerId,
            ],
            set: {
              renderOwnerName: owner.name,
              services: servicesSnapshot,
              renderApiKeyCiphertext: keyCipher.ciphertext,
              renderApiKeyNonce: keyCipher.nonce,
              renderApiKeyKeyVersion: keyCipher.keyVersion,
              apiKeyId,
              ingestKeyCiphertext: ingestCipher.ciphertext,
              ingestKeyNonce: ingestCipher.nonce,
              ingestKeyKeyVersion: ingestCipher.keyVersion,
              installedByUserId: ctx.userId,
              // A re-connect resurrects a previously revoked install and
              // resets the puller's checkpoints (the old cursor may be far in
              // the past).
              logCursor: null,
              metricsCursor: null,
              revokedAt: null,
              updatedAt: now,
            },
          });

        // Enforce a single active install per project inside the same
        // transaction: soft-revoke rows keyed to a different workspace and
        // revoke their ingest keys.
        const superseded = await tx
          .select()
          .from(schema.renderInstallations)
          .where(
            and(
              eq(schema.renderInstallations.projectId, ctx.projectId),
              ne(schema.renderInstallations.renderOwnerId, owner.id),
              isNull(schema.renderInstallations.revokedAt),
            ),
          );
        for (const row of superseded) {
          await teardownInstallation(row, tx);
        }
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

    log.info(
      { project_id: ctx.projectId, owner_id: owner.id, services: services.services.length },
      "render connected",
    );
    const row = await findInstallation(ctx.projectId);
    return row ? c.json(toPublic(row)) : c.json({ installed: false });
  });

  app.post("/api/projects/:projectId/render/uninstall", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });
    await teardownInstallation(row);
    return c.json({ ok: true });
  });
}
