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
import {
  deleteOwnerLogStream,
  deleteOwnerMetricsStream,
  fetchOwnerLogStream,
  fetchOwnerMetricsStream,
  fetchOwners,
  fetchServices,
  updateOwnerLogStream,
  upsertOwnerMetricsStream,
} from "@superlog/render";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "render" });

type Vars = { userId: string; orgId: string | null };

type RenderInstallationRow = typeof schema.renderInstallations.$inferSelect;

type StreamState = {
  status: "provisioned" | "conflict" | "unavailable";
  endpoint: string | null;
  detail: string | null;
};

/**
 * Public intake origin Render's METRICS stream pushes OTLP to (prod:
 * https://intake.superlog.sh). Unset → the metrics stream can't be
 * provisioned and metrics fall back to API polling.
 */
function streamIntakeBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.RENDER_STREAM_INTAKE_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

/**
 * Public TLS syslog address (host:port) Render's LOG stream pushes RFC 5424
 * frames to (prod: a TLS NLB in front of the proxy's syslog sink). Render's
 * log streams only support syslog destinations for third parties — custom
 * HTTPS endpoints are limited to a couple of first-class providers. Unset →
 * the log stream can't be provisioned and logs fall back to API polling.
 */
function syslogIntakeAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const address = env.RENDER_SYSLOG_INTAKE?.trim();
  return address || null;
}

/** Public shape — never leaks the API key ciphertext. */
function toPublic(row: RenderInstallationRow) {
  return {
    installed: true,
    ownerId: row.renderOwnerId,
    ownerName: row.renderOwnerName,
    services: row.services ?? [],
    logStream: row.logStream ?? null,
    metricsStream: row.metricsStream ?? null,
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
 * Provision the workspace's push streams to our intake. A workspace has
 * exactly ONE log stream and ONE metrics stream destination, so each slot is
 * read first and a foreign destination is never overwritten — that signal
 * falls back to API polling instead ("conflict"). Metrics streams are also
 * plan-gated by Render (Pro+), which surfaces here as "unavailable". Both
 * outcomes are non-fatal: the install works either way, just via polling.
 */
async function provisionStreams(input: {
  apiKey: string;
  ownerId: string;
  ingestKey: string;
  fetchImpl: typeof fetch;
}): Promise<{ logStream: StreamState; metricsStream: StreamState }> {
  const base = streamIntakeBaseUrl();
  const syslogAddress = syslogIntakeAddress();

  let logStream: StreamState;
  if (!syslogAddress) {
    logStream = {
      status: "unavailable",
      endpoint: null,
      detail: "syslog intake address not configured",
    };
  } else {
    const currentLogs = await fetchOwnerLogStream({
      apiKey: input.apiKey,
      ownerId: input.ownerId,
      fetchImpl: input.fetchImpl,
    });
    if (!currentLogs.ok) {
      logStream = { status: "unavailable", endpoint: null, detail: currentLogs.error };
    } else if (currentLogs.stream?.endpoint && currentLogs.stream.endpoint !== syslogAddress) {
      logStream = {
        status: "conflict",
        endpoint: currentLogs.stream.endpoint,
        detail: "workspace already streams logs to another destination",
      };
    } else {
      const updated = await updateOwnerLogStream({
        apiKey: input.apiKey,
        ownerId: input.ownerId,
        endpoint: syslogAddress,
        token: input.ingestKey,
        fetchImpl: input.fetchImpl,
      });
      logStream = updated.ok
        ? { status: "provisioned", endpoint: syslogAddress, detail: null }
        : { status: "unavailable", endpoint: null, detail: updated.error };
    }
  }

  if (!base) {
    return {
      logStream,
      metricsStream: {
        status: "unavailable",
        endpoint: null,
        detail: "stream intake url not configured",
      },
    };
  }
  let metricsStream: StreamState;
  const metricsEndpoint = `${base}/render/stream/metrics`;
  const currentMetrics = await fetchOwnerMetricsStream({
    apiKey: input.apiKey,
    ownerId: input.ownerId,
    fetchImpl: input.fetchImpl,
  });
  if (!currentMetrics.ok) {
    metricsStream = { status: "unavailable", endpoint: null, detail: currentMetrics.error };
  } else if (currentMetrics.stream?.url && !currentMetrics.stream.url.startsWith(base)) {
    metricsStream = {
      status: "conflict",
      endpoint: currentMetrics.stream.url,
      detail: "workspace already streams metrics to another destination",
    };
  } else {
    const updated = await upsertOwnerMetricsStream({
      apiKey: input.apiKey,
      ownerId: input.ownerId,
      url: metricsEndpoint,
      token: input.ingestKey,
      fetchImpl: input.fetchImpl,
    });
    metricsStream = updated.ok
      ? { status: "provisioned", endpoint: metricsEndpoint, detail: null }
      : { status: "unavailable", endpoint: null, detail: updated.error };
  }

  return { logStream, metricsStream };
}

/**
 * Best-effort removal of streams we provisioned. Reads each slot first and
 * only deletes a destination that still points at our intake — a customer who
 * re-pointed the stream at another provider keeps their setting.
 */
async function teardownStreams(row: RenderInstallationRow, fetchImpl: typeof fetch): Promise<void> {
  const base = streamIntakeBaseUrl();
  const syslogAddress = syslogIntakeAddress();
  let apiKey: string;
  try {
    apiKey = decryptIntegrationSecret({
      ciphertext: row.renderApiKeyCiphertext,
      nonce: row.renderApiKeyNonce,
      keyVersion: row.renderApiKeyKeyVersion,
    });
  } catch {
    return;
  }
  const ownerId = row.renderOwnerId;
  try {
    if (row.logStream?.status === "provisioned") {
      const current = await fetchOwnerLogStream({ apiKey, ownerId, fetchImpl });
      // Match against the configured address AND the address recorded at
      // provision time, so a stream provisioned before an intake move still
      // gets cleaned up.
      const ours = new Set([syslogAddress, row.logStream.endpoint].filter(Boolean));
      if (current.ok && current.stream?.endpoint && ours.has(current.stream.endpoint)) {
        await deleteOwnerLogStream({ apiKey, ownerId, fetchImpl });
      }
    }
    if (row.metricsStream?.status === "provisioned") {
      const current = await fetchOwnerMetricsStream({ apiKey, ownerId, fetchImpl });
      const ownUrl =
        (base && current.ok && current.stream?.url?.startsWith(base)) ||
        (current.ok && current.stream?.url && current.stream.url === row.metricsStream.endpoint);
      if (ownUrl) {
        await deleteOwnerMetricsStream({ apiKey, ownerId, fetchImpl });
      }
    }
  } catch (e) {
    log.warn(
      { installation_id: row.id, err: e instanceof Error ? e.message : String(e) },
      "render stream teardown failed (best-effort)",
    );
  }
}

/**
 * Tear down one installation row. Revoking the ingest key stops our intake
 * accepting anything Render (or the puller) would forward, and the
 * soft-revoke stops the puller reading Render at all. Stream removal on
 * Render's side is separate and best-effort (teardownStreams) — the user can
 * also revoke the API key from Render's dashboard. The stored Render key
 * ciphertext stays on the revoked row, unreadable without AGENT_SECRETS_KEY
 * and unused once revoked.
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

    let superseded: RenderInstallationRow[] = [];
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
        const rows = await tx
          .select()
          .from(schema.renderInstallations)
          .where(
            and(
              eq(schema.renderInstallations.projectId, ctx.projectId),
              ne(schema.renderInstallations.renderOwnerId, owner.id),
              isNull(schema.renderInstallations.revokedAt),
            ),
          );
        for (const row of rows) {
          await teardownInstallation(row, tx);
        }
        superseded = rows;
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

    // Remote IO stays out of the transaction: point the workspace's push
    // streams at our intake now that the install is durable, and best-effort
    // remove streams the superseded installs had provisioned (different
    // workspaces, so no overlap with the streams just created).
    for (const row of superseded) {
      await teardownStreams(row, fetchImpl);
    }
    const streams = await provisionStreams({
      apiKey,
      ownerId: owner.id,
      ingestKey,
      fetchImpl,
    });
    await db
      .update(schema.renderInstallations)
      .set({ logStream: streams.logStream, metricsStream: streams.metricsStream })
      .where(
        and(
          eq(schema.renderInstallations.projectId, ctx.projectId),
          eq(schema.renderInstallations.renderOwnerId, owner.id),
          isNull(schema.renderInstallations.revokedAt),
        ),
      );

    log.info(
      {
        project_id: ctx.projectId,
        owner_id: owner.id,
        services: services.services.length,
        log_stream: streams.logStream.status,
        metrics_stream: streams.metricsStream.status,
      },
      "render connected",
    );
    const row = await findInstallation(ctx.projectId);
    return row ? c.json(toPublic(row)) : c.json({ installed: false });
  });

  app.post("/api/projects/:projectId/render/uninstall", async (c) => {
    const ctx = await requireProjectAccess(c, c.req.param("projectId"));
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });
    // Deprovision on Render's side while the stored key is still ours to use,
    // then revoke locally.
    await teardownStreams(row, fetchImpl);
    await teardownInstallation(row);
    return c.json({ ok: true });
  });
}
