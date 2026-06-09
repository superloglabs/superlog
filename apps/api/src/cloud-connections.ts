import { timingSafeEqual } from "node:crypto";
import { db, decryptIntegrationSecret, encryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  type StsVerifier,
  buildConnectQuickCreateUrl,
  generateExternalId,
  verifyConnection,
} from "./cloud-connections-service.js";
import { createStsVerifier } from "./cloud-connections-sts.js";
import { createConfigFetcher, createResourceLister } from "./cloud-resources-aws.js";
import {
  type ConfigFetcher,
  type ResourceLister,
  enrichConnectionResources,
  syncConnectionResources,
} from "./cloud-resources-service.js";
import { resolveActiveOrgContext } from "./org-context.js";
import { buildServiceMap } from "./service-map-service.js";

type Vars = { userId: string; orgId: string | null };

export type CloudConnectConfig = {
  /**
   * The Superlog AWS account the customer's role trusts. Passed as a stack
   * *parameter value* in the launch URL — never baked into the committed
   * (open-core) template, so prod topology stays out of the public repo.
   */
  superlogAccountId: string;
  /** Public HTTPS URL of the CloudFormation template. */
  templateUrl: string;
  /**
   * Our SNS topic ARN, used as the custom-resource `ServiceToken` for zero-paste
   * connect (the stack reports its role ARN back to us via SNS). Optional — when
   * unset, the launch URL omits it and the template's custom resource is skipped,
   * so the customer falls back to pasting the role ARN.
   */
  serviceToken?: string;
};

export function cloudConnectConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CloudConnectConfig | null {
  const superlogAccountId = env.SUPERLOG_AWS_ACCOUNT_ID;
  const templateUrl = env.AWS_CONNECT_TEMPLATE_URL;
  if (!superlogAccountId || !templateUrl) return null;
  return {
    superlogAccountId,
    templateUrl,
    serviceToken: env.AWS_CONNECT_SERVICE_TOKEN || undefined,
  };
}

// Region is lowercase letters/digits/hyphens only — it's interpolated into the
// launch URL's hostname, so reject anything that could redirect the link.
const createSchema = z.object({ region: z.string().regex(/^[a-z0-9-]{1,32}$/) });
const verifySchema = z.object({ scrapeRoleArn: z.string().min(1) });
const callbackSchema = z.object({
  connectionId: z.string().uuid(),
  externalId: z.string().min(1),
  roleArn: z.string().min(1),
});

/** Constant-time string compare (avoids leaking the external id via timing). */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

type CloudConnectionRow = typeof schema.cloudConnections.$inferSelect;

/** Public shape — deliberately omits the encrypted external-id columns. */
function toPublic(row: CloudConnectionRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    region: row.region,
    scrapeRoleArn: row.scrapeRoleArn,
    accountId: row.accountId,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Assume the role with the connection's stored external ID and record the
 * outcome. Shared by the manual verify route and the zero-paste callback.
 */
async function applyVerifyAndUpdate(
  row: CloudConnectionRow,
  roleArn: string,
  sts: StsVerifier,
): Promise<CloudConnectionRow> {
  const externalId = decryptIntegrationSecret({
    ciphertext: row.externalIdCiphertext,
    nonce: row.externalIdNonce,
    keyVersion: row.externalIdKeyVersion,
  });
  const result = await verifyConnection({ roleArn, externalId }, sts);
  const now = new Date();

  return db.transaction(async (tx) => {
    // Reconnecting a role already active in this project would collide with the
    // unique (project, scrape_role_arn) index. Revoke the prior active row first
    // so the reconnect replaces it instead of 500-ing. Only on a real claim —
    // a failed verify must not revoke a working connection.
    if (result.status !== "failed") {
      await tx
        .update(schema.cloudConnections)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.cloudConnections.projectId, row.projectId),
            eq(schema.cloudConnections.scrapeRoleArn, roleArn),
            ne(schema.cloudConnections.id, row.id),
            isNull(schema.cloudConnections.revokedAt),
          ),
        );
    }
    const [updated] = await tx
      .update(schema.cloudConnections)
      .set({
        // On failure keep the existing ARN (don't write a value another active
        // row holds, which would also collide on the unique index).
        scrapeRoleArn: result.status === "failed" ? row.scrapeRoleArn : roleArn,
        status: result.status,
        accountId: result.status === "failed" ? row.accountId : result.accountId,
        lastVerifiedAt: now,
        lastError: result.status === "failed" ? result.reason : null,
        updatedAt: now,
      })
      .where(eq(schema.cloudConnections.id, row.id))
      .returning();
    if (!updated) throw new HTTPException(404, { message: "connection not found" });
    return updated;
  });
}

export function mountCloudConnectionsAuthed(
  app: Hono<{ Variables: Vars }>,
  deps: {
    sts?: StsVerifier;
    config?: CloudConnectConfig | null;
    resourceLister?: ResourceLister;
    configFetcher?: ConfigFetcher;
  } = {},
): void {
  const sts = deps.sts ?? createStsVerifier();
  const config = deps.config !== undefined ? deps.config : cloudConnectConfigFromEnv();
  const resourceLister = deps.resourceLister ?? createResourceLister();
  const configFetcher = deps.configFetcher ?? createConfigFetcher();

  const requireAccess = async (c: Context<{ Variables: Vars }>, projectId: string) => {
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, projectId),
    });
    if (!project) throw new HTTPException(404, { message: "project not found" });
    const ctx = await resolveActiveOrgContext({
      userId: c.var.userId,
      preferredOrgId: c.var.orgId,
    });
    if (project.orgId !== ctx.org.id) throw new HTTPException(403, { message: "forbidden" });
    return { project, user: ctx.user };
  };

  app.get("/api/projects/:projectId/cloud-connections", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAccess(c, projectId);
    const rows = await db.query.cloudConnections.findMany({
      where: and(
        eq(schema.cloudConnections.projectId, projectId),
        isNull(schema.cloudConnections.revokedAt),
      ),
    });
    return c.json(rows.map(toPublic));
  });

  // Step 1 of connect: mint the external ID (stored encrypted), hand back the
  // CloudFormation launch URL. The role doesn't exist yet — it's created when the
  // customer deploys the stack and reported back at verify.
  app.post("/api/projects/:projectId/cloud-connections", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    if (!config) throw new HTTPException(500, { message: "AWS connect is not configured" });
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });

    const externalId = generateExternalId();
    const cipher = encryptIntegrationSecret(externalId);
    const [row] = await db
      .insert(schema.cloudConnections)
      .values({
        projectId,
        region: parsed.data.region,
        externalIdCiphertext: cipher.ciphertext,
        externalIdNonce: cipher.nonce,
        externalIdKeyVersion: cipher.keyVersion,
        createdBy: user.id,
      })
      .returning();
    if (!row) throw new HTTPException(500, { message: "failed to create connection" });

    const params: Record<string, string> = {
      ExternalId: externalId,
      SuperlogAccountId: config.superlogAccountId,
      ConnectionId: row.id,
    };
    // When we have an SNS topic, pass it so the template's custom resource reports
    // the role ARN back automatically (zero-paste). Otherwise the customer pastes.
    if (config.serviceToken) params.SuperlogServiceToken = config.serviceToken;

    const launchUrl = buildConnectQuickCreateUrl({
      region: parsed.data.region,
      templateUrl: config.templateUrl,
      stackName: "superlog-connect",
      params,
    });
    // externalId returned once so the UI can show it; it's also in the launch URL.
    return c.json({ ...toPublic(row), launchUrl, externalId });
  });

  // Step 2 of connect: customer pasted the role ARN from the stack outputs.
  // Assume it with the stored external ID and record the outcome.
  app.post("/api/projects/:projectId/cloud-connections/:id/verify", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    const parsed = verifySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });

    const row = await db.query.cloudConnections.findFirst({
      where: and(
        eq(schema.cloudConnections.id, id),
        eq(schema.cloudConnections.projectId, projectId),
        isNull(schema.cloudConnections.revokedAt),
      ),
    });
    if (!row) throw new HTTPException(404, { message: "connection not found" });

    const updated = await applyVerifyAndUpdate(row, parsed.data.scrapeRoleArn, sts);
    return c.json(toPublic(updated));
  });

  // Zero-paste callback: the CloudFormation custom resource (via our SNS topic →
  // bridge) reports the freshly-created role ARN. No session — authenticated by
  // connectionId + a constant-time match on the stored external ID. AssumeRole is
  // still the real trust gate (a forged ARN we can't assume just stays `failed`).
  // NOTE: the path is allowlisted in index.ts's session middleware.
  app.post("/api/cloud-connections/callback", async (c) => {
    const parsed = callbackSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });

    const row = await db.query.cloudConnections.findFirst({
      where: and(
        eq(schema.cloudConnections.id, parsed.data.connectionId),
        isNull(schema.cloudConnections.revokedAt),
      ),
    });
    if (!row) throw new HTTPException(404, { message: "connection not found" });

    const externalId = decryptIntegrationSecret({
      ciphertext: row.externalIdCiphertext,
      nonce: row.externalIdNonce,
      keyVersion: row.externalIdKeyVersion,
    });
    if (!secretEquals(externalId, parsed.data.externalId)) {
      throw new HTTPException(403, { message: "invalid external id" });
    }

    const updated = await applyVerifyAndUpdate(row, parsed.data.roleArn, sts);
    return c.json(toPublic(updated));
  });

  app.delete("/api/projects/:projectId/cloud-connections/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    await db
      .update(schema.cloudConnections)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(schema.cloudConnections.id, id), eq(schema.cloudConnections.projectId, projectId)),
      );
    return c.json({ ok: true });
  });

  // Service map: cluster the project's resources into logical services (+ lanes
  // and inferred edges) for the topology view.
  app.get("/api/projects/:projectId/service-map", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAccess(c, projectId);
    const rows = await db.query.cloudResources.findMany({
      where: and(
        eq(schema.cloudResources.projectId, projectId),
        isNull(schema.cloudResources.removedAt),
      ),
    });
    return c.json(
      buildServiceMap(
        rows.map((r) => ({
          arn: r.arn,
          service: r.service,
          resourceType: r.resourceType,
          name: r.name,
          tags: r.tags,
          config: r.config as Record<string, unknown> | null,
        })),
      ),
    );
  });

  // Inventory: list the project's discovered AWS resources (excludes soft-removed).
  app.get("/api/projects/:projectId/cloud-resources", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAccess(c, projectId);
    const rows = await db.query.cloudResources.findMany({
      where: and(
        eq(schema.cloudResources.projectId, projectId),
        isNull(schema.cloudResources.removedAt),
      ),
    });
    return c.json(
      rows.map((r) => ({
        id: r.id,
        connectionId: r.connectionId,
        arn: r.arn,
        service: r.service,
        resourceType: r.resourceType,
        region: r.region,
        accountId: r.accountId,
        name: r.name,
        tags: r.tags,
        lastSeenAt: r.lastSeenAt,
      })),
    );
  });

  // Trigger an inventory sweep for one connection: assume the role, list
  // resources via ResourceGroupsTaggingAPI, upsert the registry.
  app.post("/api/projects/:projectId/cloud-connections/:id/sync", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);

    const row = await db.query.cloudConnections.findFirst({
      where: and(
        eq(schema.cloudConnections.id, id),
        eq(schema.cloudConnections.projectId, projectId),
        isNull(schema.cloudConnections.revokedAt),
      ),
    });
    if (!row) throw new HTTPException(404, { message: "connection not found" });
    if (row.status !== "connected" || !row.scrapeRoleArn) {
      throw new HTTPException(409, { message: "connection is not verified" });
    }

    const externalId = decryptIntegrationSecret({
      ciphertext: row.externalIdCiphertext,
      nonce: row.externalIdNonce,
      keyVersion: row.externalIdKeyVersion,
    });
    const target = {
      id: row.id,
      projectId: row.projectId,
      scrapeRoleArn: row.scrapeRoleArn,
      externalId,
      region: row.region,
    };
    const result = await syncConnectionResources(target, resourceLister);
    // Best-effort config enrichment (Cloud Control); never fails the sync.
    let enrichment = { enriched: 0, skipped: 0 };
    try {
      enrichment = await enrichConnectionResources(target, configFetcher);
    } catch (err) {
      console.error("[cloud-connections] config enrichment failed", err);
    }
    return c.json({ ...result, ...enrichment });
  });
}
