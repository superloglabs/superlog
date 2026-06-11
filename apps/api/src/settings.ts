import {
  db,
  encryptIntegrationSecret,
  resolveDefaultAgentRunProvider,
  schema,
} from "@superlog/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import { INTEGRATION_MANIFESTS } from "./integrations-manifest.js";
import { resolveActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; orgId: string | null };

const ORG_INSTRUCTIONS_MAX_LEN = 8000;
const PROJECT_CONTEXT_MAX_LEN = 8000;

const AGENT_MEMORY_TITLE_MAX_LEN = 200;
const AGENT_MEMORY_BODY_MAX_LEN = 4000;
const AGENT_MEMORY_KINDS: schema.AgentMemoryKind[] = [
  "feedback",
  "terminology",
  "infra",
  "project",
];

function parseMemoryKind(value: unknown): schema.AgentMemoryKind | null {
  return typeof value === "string" && (AGENT_MEMORY_KINDS as string[]).includes(value)
    ? (value as schema.AgentMemoryKind)
    : null;
}

function parseMemoryText(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLen);
}

function serializeAgentMemory(row: schema.AgentMemory) {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    status: row.status,
    source: row.sourceAgentRunId ? "agent" : row.sourceUserId ? "user" : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const PROJECT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PROJECT_NAME_MAX_LEN = 80;

function slugifyProjectName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "project";
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSettingsAuthed(app: Hono<any>): void {
  app.get("/api/org/agent-settings", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ customInstructions: "" });
    const row = await db.query.orgAgentSettings.findFirst({
      where: eq(schema.orgAgentSettings.orgId, ctx.orgId),
    });
    return c.json({ customInstructions: row?.customInstructions ?? "" });
  });

  app.put("/api/org/agent-settings", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      customInstructions?: unknown;
    };
    if (typeof body.customInstructions !== "string") {
      return c.json({ error: "customInstructions must be a string" }, 400);
    }
    const customInstructions = body.customInstructions.slice(0, ORG_INSTRUCTIONS_MAX_LEN);
    await db
      .insert(schema.orgAgentSettings)
      .values({ orgId: ctx.orgId, customInstructions })
      .onConflictDoUpdate({
        target: schema.orgAgentSettings.orgId,
        set: { customInstructions, updatedAt: new Date() },
      });
    return c.json({ customInstructions });
  });

  // Agent memories are strictly project-scoped: every route requires a
  // project that belongs to the caller's org, and rows never leak across
  // projects.
  app.get("/api/org/projects/:projectId/agent-memories", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    const rows = await db.query.agentMemories.findMany({
      where: and(
        eq(schema.agentMemories.orgId, scope.orgId),
        eq(schema.agentMemories.projectId, scope.projectId),
      ),
      orderBy: [asc(schema.agentMemories.createdAt)],
    });
    return c.json({ memories: rows.map(serializeAgentMemory) });
  });

  app.post("/api/org/projects/:projectId/agent-memories", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = parseMemoryKind(body.kind);
    if (!kind)
      return c.json({ error: "kind must be one of: feedback, terminology, infra, project" }, 400);
    const title = parseMemoryText(body.title, AGENT_MEMORY_TITLE_MAX_LEN);
    if (!title) return c.json({ error: "title is required" }, 400);
    const memoryBody = parseMemoryText(body.body, AGENT_MEMORY_BODY_MAX_LEN);
    if (!memoryBody) return c.json({ error: "body is required" }, 400);
    const [row] = await db
      .insert(schema.agentMemories)
      .values({
        orgId: scope.orgId,
        projectId: scope.projectId,
        kind,
        title,
        body: memoryBody,
        sourceUserId: scope.userId,
      })
      .returning();
    if (!row) return c.json({ error: "failed to create memory" }, 500);
    return c.json({ memory: serializeAgentMemory(row) });
  });

  app.put("/api/org/projects/:projectId/agent-memories/:id", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Partial<typeof schema.agentMemories.$inferInsert> = {};
    if (body.kind !== undefined) {
      const kind = parseMemoryKind(body.kind);
      if (!kind) return c.json({ error: "invalid kind" }, 400);
      patch.kind = kind;
    }
    if (body.title !== undefined) {
      const title = parseMemoryText(body.title, AGENT_MEMORY_TITLE_MAX_LEN);
      if (!title) return c.json({ error: "title must be a non-empty string" }, 400);
      patch.title = title;
    }
    if (body.body !== undefined) {
      const memoryBody = parseMemoryText(body.body, AGENT_MEMORY_BODY_MAX_LEN);
      if (!memoryBody) return c.json({ error: "body must be a non-empty string" }, 400);
      patch.body = memoryBody;
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "archived") {
        return c.json({ error: "status must be active or archived" }, 400);
      }
      patch.status = body.status;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "provide at least one of kind, title, body, status" }, 400);
    }
    const [row] = await db
      .update(schema.agentMemories)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentMemories.id, c.req.param("id")),
          eq(schema.agentMemories.orgId, scope.orgId),
          eq(schema.agentMemories.projectId, scope.projectId),
        ),
      )
      .returning();
    if (!row) return c.json({ error: "memory not found" }, 404);
    return c.json({ memory: serializeAgentMemory(row) });
  });

  app.delete("/api/org/projects/:projectId/agent-memories/:id", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    const [row] = await db
      .delete(schema.agentMemories)
      .where(
        and(
          eq(schema.agentMemories.id, c.req.param("id")),
          eq(schema.agentMemories.orgId, scope.orgId),
          eq(schema.agentMemories.projectId, scope.projectId),
        ),
      )
      .returning({ id: schema.agentMemories.id });
    if (!row) return c.json({ error: "memory not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/org/digest", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) {
      return c.json({
        enabled: false,
        channelId: null,
        channelName: null,
        installationId: null,
        lastRunAt: null,
      });
    }
    const row = await db.query.orgAgentSettings.findFirst({
      where: eq(schema.orgAgentSettings.orgId, ctx.orgId),
    });
    return c.json({
      enabled: row?.digestEnabled ?? false,
      channelId: row?.digestSlackChannelId ?? null,
      channelName: row?.digestSlackChannelName ?? null,
      installationId: row?.digestSlackInstallationId ?? null,
      lastRunAt: row?.digestLastRunAt?.toISOString() ?? null,
    });
  });

  app.put("/api/org/digest", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: unknown;
      channelId?: unknown;
      channelName?: unknown;
    };
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    const channelIdRaw =
      body.channelId === null
        ? null
        : typeof body.channelId === "string"
          ? body.channelId
          : undefined;
    const channelNameRaw =
      body.channelName === null
        ? null
        : typeof body.channelName === "string"
          ? body.channelName
          : undefined;

    // Digest is org-scoped today; pick any active slack install in the org
    // by joining through projects. (One install per project — for orgs with
    // multiple projects + multiple installs this returns an arbitrary one,
    // same ambiguity as the previous org-scoped lookup.)
    const installs = await db
      .select({
        id: schema.slackInstallations.id,
      })
      .from(schema.slackInstallations)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.slackInstallations.projectId))
      .where(and(eq(schema.projects.orgId, ctx.orgId), isNull(schema.slackInstallations.revokedAt)))
      .limit(1);
    const install = installs[0] ?? null;

    if (enabled === true && !channelIdRaw && !install) {
      return c.json({ error: "Slack must be installed to enable the digest" }, 400);
    }

    const update: Partial<typeof schema.orgAgentSettings.$inferInsert> = { updatedAt: new Date() };
    if (enabled !== undefined) update.digestEnabled = enabled;
    if (channelIdRaw !== undefined) {
      update.digestSlackChannelId = channelIdRaw;
      update.digestSlackInstallationId = channelIdRaw ? (install?.id ?? null) : null;
    }
    if (channelNameRaw !== undefined) update.digestSlackChannelName = channelNameRaw;

    await db
      .insert(schema.orgAgentSettings)
      .values({
        orgId: ctx.orgId,
        digestEnabled: enabled ?? false,
        digestSlackChannelId: channelIdRaw ?? null,
        digestSlackChannelName: channelNameRaw ?? null,
        digestSlackInstallationId:
          channelIdRaw && install ? install.id : channelIdRaw === null ? null : null,
      })
      .onConflictDoUpdate({
        target: schema.orgAgentSettings.orgId,
        set: update,
      });

    const row = await db.query.orgAgentSettings.findFirst({
      where: eq(schema.orgAgentSettings.orgId, ctx.orgId),
    });
    return c.json({
      enabled: row?.digestEnabled ?? false,
      channelId: row?.digestSlackChannelId ?? null,
      channelName: row?.digestSlackChannelName ?? null,
      installationId: row?.digestSlackInstallationId ?? null,
      lastRunAt: row?.digestLastRunAt?.toISOString() ?? null,
    });
  });

  app.post("/api/org/digest/run-now", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const row = await db.query.orgAgentSettings.findFirst({
      where: eq(schema.orgAgentSettings.orgId, ctx.orgId),
    });
    if (!row?.digestSlackChannelId || !row?.digestSlackInstallationId) {
      return c.json({ error: "configure a Slack channel for the digest first" }, 400);
    }
    // Worker fires next tick when last_run_at is null. We also bump enabled to
    // true so manual runs work even if the user hasn't flipped the toggle yet.
    await db
      .update(schema.orgAgentSettings)
      .set({ digestEnabled: true, digestLastRunAt: null, updatedAt: new Date() })
      .where(eq(schema.orgAgentSettings.orgId, ctx.orgId));
    return c.json({ ok: true });
  });

  app.get("/api/org/projects", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ projects: [] });
    const rows = await db.query.projects.findMany({
      where: eq(schema.projects.orgId, ctx.orgId),
      orderBy: [asc(schema.projects.createdAt)],
    });
    return c.json({
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        projectContext: p.projectContext,
      })),
    });
  });

  app.post("/api/org/projects", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      slug?: unknown;
      projectContext?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    if (name.length > PROJECT_NAME_MAX_LEN) {
      return c.json({ error: `name must be ≤ ${PROJECT_NAME_MAX_LEN} chars` }, 400);
    }
    const slugInput =
      typeof body.slug === "string" && body.slug.trim()
        ? body.slug.trim().toLowerCase()
        : slugifyProjectName(name);
    if (!PROJECT_SLUG_RE.test(slugInput) || slugInput.length > 40) {
      return c.json({ error: "slug must be lowercase alphanumeric + dashes, max 40 chars" }, 400);
    }
    const existing = await db.query.projects.findFirst({
      where: and(eq(schema.projects.orgId, ctx.orgId), eq(schema.projects.slug, slugInput)),
    });
    if (existing) return c.json({ error: "slug already in use in this org" }, 409);

    const [project] = await db
      .insert(schema.projects)
      .values({
        orgId: ctx.orgId,
        name,
        slug: slugInput,
        projectContext:
          typeof body.projectContext === "string"
            ? body.projectContext.slice(0, PROJECT_CONTEXT_MAX_LEN)
            : "",
      })
      .returning();
    if (!project) return c.json({ error: "failed to create project" }, 500);
    await db
      .insert(schema.projectAutomationSettings)
      .values({ projectId: project.id, agentRunProvider: resolveDefaultAgentRunProvider() })
      .onConflictDoNothing({ target: schema.projectAutomationSettings.projectId });
    return c.json({
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        projectContext: project.projectContext,
      },
    });
  });

  app.patch("/api/org/projects/:projectId", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const projectId = c.req.param("projectId");
    const target = await db.query.projects.findFirst({
      where: and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, ctx.orgId)),
    });
    if (!target) return c.json({ error: "project not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      slug?: unknown;
      projectContext?: unknown;
    };
    const patch: Partial<typeof schema.projects.$inferInsert> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return c.json({ error: "name cannot be empty" }, 400);
      if (name.length > PROJECT_NAME_MAX_LEN) {
        return c.json({ error: `name must be ≤ ${PROJECT_NAME_MAX_LEN} chars` }, 400);
      }
      patch.name = name;
    }
    if (typeof body.slug === "string") {
      const slug = body.slug.trim().toLowerCase();
      if (!PROJECT_SLUG_RE.test(slug) || slug.length > 40) {
        return c.json({ error: "slug must be lowercase alphanumeric + dashes, max 40 chars" }, 400);
      }
      if (slug !== target.slug) {
        const clash = await db.query.projects.findFirst({
          where: and(eq(schema.projects.orgId, ctx.orgId), eq(schema.projects.slug, slug)),
        });
        if (clash) return c.json({ error: "slug already in use in this org" }, 409);
        patch.slug = slug;
      }
    }
    if (typeof body.projectContext === "string") {
      patch.projectContext = body.projectContext.slice(0, PROJECT_CONTEXT_MAX_LEN);
    }
    if (Object.keys(patch).length === 0) {
      return c.json({
        project: {
          id: target.id,
          name: target.name,
          slug: target.slug,
          projectContext: target.projectContext,
        },
      });
    }
    const [updated] = await db
      .update(schema.projects)
      .set(patch)
      .where(eq(schema.projects.id, target.id))
      .returning();
    // A concurrent DELETE between the findFirst above and this UPDATE leaves
    // `updated` undefined — return a clean 404 rather than a TypeError 500.
    if (!updated) return c.json({ error: "project not found" }, 404);
    return c.json({
      project: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        projectContext: updated.projectContext,
      },
    });
  });

  app.delete("/api/org/projects/:projectId", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const projectId = c.req.param("projectId");

    // The count-check and the delete must be atomic, or two concurrent
    // deletes in a 2-project org can both pass the `> 1` guard and leave
    // the org with zero projects. Wrap in a tx and take SELECT FOR UPDATE
    // locks on every project row in this org — any concurrent delete of a
    // sibling will block until our tx commits, at which point its count
    // sees the post-delete state.
    const result = await db.transaction(async (tx) => {
      const target = await tx.query.projects.findFirst({
        where: and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, ctx.orgId)),
      });
      if (!target) return { status: 404 as const, body: { error: "project not found" } };
      const locked = await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.orgId, ctx.orgId))
        .for("update");
      if (locked.length <= 1) {
        return {
          status: 409 as const,
          body: { error: "cannot delete the last project in an org" },
        };
      }
      await tx.delete(schema.projects).where(eq(schema.projects.id, target.id));
      return { status: 200 as const, body: { ok: true } };
    });
    return c.json(result.body, result.status);
  });

  app.get("/api/org/integrations", async (c) => {
    const ctx = await resolveUserOrg(c);
    const installed = ctx
      ? await db.query.orgIntegrations.findMany({
          where: eq(schema.orgIntegrations.orgId, ctx.orgId),
        })
      : [];
    const installedBySlug = new Map(installed.map((row) => [row.slug, row]));
    const presentSecrets = ctx
      ? await db.query.orgIntegrationSecrets.findMany({
          where:
            installed.length > 0
              ? inArray(
                  schema.orgIntegrationSecrets.orgIntegrationId,
                  installed.map((row) => row.id),
                )
              : undefined,
        })
      : [];
    const presentByIntegrationId = new Map<string, Set<string>>();
    for (const s of presentSecrets) {
      const set = presentByIntegrationId.get(s.orgIntegrationId) ?? new Set<string>();
      set.add(s.secretName);
      presentByIntegrationId.set(s.orgIntegrationId, set);
    }

    const items = Object.values(INTEGRATION_MANIFESTS).map((manifest) => {
      const row = installedBySlug.get(manifest.slug);
      const present = row
        ? (presentByIntegrationId.get(row.id) ?? new Set<string>())
        : new Set<string>();
      return {
        slug: manifest.slug,
        name: manifest.name,
        description: manifest.description,
        installed: !!row,
        enabled: row?.enabled ?? false,
        required_secrets: manifest.required_secrets.map((spec) => ({
          name: spec.name,
          description: spec.description,
          present: present.has(spec.name),
        })),
      };
    });
    return c.json({ integrations: items });
  });

  app.put("/api/org/integrations/:slug", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const slug = c.req.param("slug");
    const manifest = INTEGRATION_MANIFESTS[slug];
    if (!manifest) return c.json({ error: "unknown integration" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: unknown;
      secrets?: unknown;
    };
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    const secrets =
      body.secrets && typeof body.secrets === "object" && !Array.isArray(body.secrets)
        ? (body.secrets as Record<string, unknown>)
        : null;

    if (secrets) {
      for (const key of Object.keys(secrets)) {
        if (!manifest.required_secrets.some((s) => s.name === key)) {
          return c.json({ error: `unknown secret: ${key}` }, 400);
        }
        const value = secrets[key];
        if (value !== null && typeof value !== "string") {
          return c.json({ error: `secret ${key} must be a string or null` }, 400);
        }
      }
    }

    const existing = await db.query.orgIntegrations.findFirst({
      where: and(
        eq(schema.orgIntegrations.orgId, ctx.orgId),
        eq(schema.orgIntegrations.slug, slug),
      ),
    });

    const integrationRow = existing
      ? (
          await db
            .update(schema.orgIntegrations)
            .set({
              enabled: enabled ?? existing.enabled,
              updatedAt: new Date(),
            })
            .where(eq(schema.orgIntegrations.id, existing.id))
            .returning()
        )[0]!
      : (
          await db
            .insert(schema.orgIntegrations)
            .values({
              orgId: ctx.orgId,
              slug,
              enabled: enabled ?? true,
            })
            .returning()
        )[0]!;

    if (secrets) {
      for (const [name, value] of Object.entries(secrets)) {
        if (value === null) {
          await db
            .delete(schema.orgIntegrationSecrets)
            .where(
              and(
                eq(schema.orgIntegrationSecrets.orgIntegrationId, integrationRow.id),
                eq(schema.orgIntegrationSecrets.secretName, name),
              ),
            );
          continue;
        }
        if (typeof value !== "string" || value.length === 0) continue;
        const cipher = encryptIntegrationSecret(value);
        await db
          .insert(schema.orgIntegrationSecrets)
          .values({
            orgIntegrationId: integrationRow.id,
            secretName: name,
            ciphertext: cipher.ciphertext,
            nonce: cipher.nonce,
            keyVersion: cipher.keyVersion,
          })
          .onConflictDoUpdate({
            target: [
              schema.orgIntegrationSecrets.orgIntegrationId,
              schema.orgIntegrationSecrets.secretName,
            ],
            set: {
              ciphertext: cipher.ciphertext,
              nonce: cipher.nonce,
              keyVersion: cipher.keyVersion,
              updatedAt: new Date(),
            },
          });
      }
    }

    return c.json({ ok: true });
  });

  app.delete("/api/org/integrations/:slug", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const slug = c.req.param("slug");
    if (!INTEGRATION_MANIFESTS[slug]) return c.json({ error: "unknown integration" }, 404);
    await db
      .delete(schema.orgIntegrations)
      .where(
        and(eq(schema.orgIntegrations.orgId, ctx.orgId), eq(schema.orgIntegrations.slug, slug)),
      );
    return c.json({ ok: true });
  });
}

async function resolveUserOrg(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; orgId: string } | null> {
  const userId = c.var.userId;
  if (!userId) return null;
  const ctx = await resolveActiveOrgContext({
    userId,
    preferredOrgId: c.var.orgId,
  }).catch(() => null);
  if (!ctx) return null;
  return { userId: ctx.user.id, orgId: ctx.org.id };
}

// resolveUserOrg plus a :projectId param check — the project must belong to
// the caller's org or the route behaves as if it doesn't exist.
async function resolveProjectScope(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; orgId: string; projectId: string } | null> {
  const ctx = await resolveUserOrg(c);
  if (!ctx) return null;
  const projectId = c.req.param("projectId");
  if (!projectId) return null;
  const project = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, ctx.orgId)),
    columns: { id: true },
  });
  if (!project) return null;
  return { ...ctx, projectId: project.id };
}
