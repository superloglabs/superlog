import type { ClickHouseClient } from "@clickhouse/client";
import { Scalar } from "@scalar/hono-api-reference";
import {
  db,
  isIngestApiKey,
  isOrgManagementKey,
  mintApiKey,
  mintOrgApiKey,
  resolveOrgApiKey,
  schema,
} from "@superlog/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { describeRoute, openAPIRouteHandler, resolver, validator } from "hono-openapi";
import { HTTPException } from "hono/http-exception";
import {
  buildGithubMgmtInstallUrl,
  fetchInstallationRepoById,
  listCurrentInstallationRepos,
} from "./github.js";
import { logger } from "./logger.js";
import { resolvePublicSourceMapUploadAuth } from "./management-auth.js";
import {
  apiKeyListResponseSchema,
  createProjectInputSchema,
  createProjectResponseSchema,
  errorResponseSchema,
  githubInstallationListResponseSchema,
  githubRepoListResponseSchema,
  grantListResponseSchema,
  grantRepoInputSchema,
  grantRepoResponseSchema,
  installUrlInputSchema,
  installUrlResponseSchema,
  installationRowIdParamSchema,
  logsQuerySchema,
  metricsQuerySchema,
  mintApiKeyInputSchema,
  mintApiKeyResponseSchema,
  okResponseSchema,
  projectIdParamSchema,
  projectListResponseSchema,
  projectResponseSchema,
  repoIdParamSchema,
  telemetryReadResponseSchema,
  traceByIdParamSchema,
  updateProjectInputSchema,
} from "./management-schemas.js";
import { getTraceDetail, queryLogs, queryMetrics } from "./mcp/clickhouse.js";
import { resolveActiveOrgContext } from "./org-context.js";
import {
  sourceMapObjectStoreFromEnv,
  sourceMapUploadSchema,
  storeSourceMapArtifact,
} from "./sourcemaps.js";

const log = logger.child({ scope: "management" });
const sourceMapObjectStore = sourceMapObjectStoreFromEnv(process.env);

type MgmtVars = {
  managementOrgId: string;
  managementKeyId: string;
  sourceMapUploadProjectId?: string;
};
type DashboardVars = { userId: string; orgId: string | null };

async function getAutomergeForProject(projectId: string): Promise<{
  automerge_fix_prs: schema.AutoMergePolicy;
  automerge_method: schema.AutoMergeMethod;
  pr_base_branch: string | null;
}> {
  const row = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
  });
  return {
    automerge_fix_prs: row?.autoMergeFixPrs ?? "never",
    automerge_method: row?.autoMergeMethod ?? "squash",
    pr_base_branch: schema.normalizePrBaseBranch(row?.prBaseBranch),
  };
}

function parsePrBaseBranch(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== "string") return undefined;
  const branch = schema.normalizePrBaseBranch(input);
  if (branch && !schema.isValidPrBaseBranch(branch)) {
    throw new HTTPException(400, {
      message:
        "pr_base_branch must be a valid Git branch name, or blank to use the repository default",
    });
  }
  return branch;
}

// Shared response stubs so individual routes don't repeat themselves.
const errorContent = {
  "application/json": { schema: resolver(errorResponseSchema) },
};
const COMMON_ERRORS = {
  401: { description: "Missing / wrong-type / revoked token", content: errorContent },
};
const NOT_FOUND = {
  404: {
    description: "Resource not found in this org",
    content: errorContent,
  },
};
const BAD_REQUEST = {
  400: { description: "Malformed input", content: errorContent },
};
const CONFLICT = {
  409: { description: "Conflict (e.g. slug already in use)", content: errorContent },
};
const BAD_GATEWAY = {
  502: { description: "Upstream GitHub call failed", content: errorContent },
};
const SERVICE_UNAVAILABLE = {
  503: { description: "GitHub App not configured server-side", content: errorContent },
};

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountManagementApi(
  app: Hono<any>,
  opts: { ch: ClickHouseClient; chHeavy?: ClickHouseClient },
): void {
  const { ch, chHeavy = ch } = opts;
  // Public docs paths (openapi.json + Scalar reference) are mounted first so
  // they don't go through the bearer-token middleware below.
  app.get(
    "/api/v1/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        openapi: "3.1.0",
        info: {
          title: "Superlog Management API",
          version: "1.0.0",
          description:
            "Programmatic surface for provisioning projects, ingest keys, and " +
            "GitHub access. Authenticated with org-scoped management keys " +
            "(prefix `sl_management_*`).",
        },
        servers: [
          { url: "https://api.superlog.sh", description: "Production" },
          { url: "http://localhost:4100", description: "Local dev" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "sl_management_*",
            },
          },
        },
        security: [{ bearerAuth: [] }],
        tags: [{ name: "Projects" }, { name: "API keys" }, { name: "GitHub integration" }],
      },
      excludeStaticFile: true,
    }),
  );
  app.get(
    "/api/v1/docs",
    Scalar({
      url: "/api/v1/openapi.json",
      pageTitle: "Superlog Management API",
    }),
  );

  // Auth middleware. Sits at /api/v1/* — the parent /api/* session middleware
  // already skips this prefix (see index.ts). The docs paths above bypass
  // this by short-circuiting before next() is called.
  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/openapi.json" || c.req.path === "/api/v1/docs") {
      return next();
    }
    const header = c.req.header("authorization");
    if (!header?.toLowerCase().startsWith("bearer ")) {
      return c.json({ error: "missing bearer token" }, 401);
    }
    const token = header.slice(7).trim();
    if (isIngestApiKey(token)) {
      const resolved = await resolvePublicSourceMapUploadAuth({
        database: db,
        method: c.req.method,
        path: c.req.path,
        token,
      });
      if (!resolved) {
        return c.json(
          {
            error:
              "wrong credential type: public ingest keys can only upload source maps for their own project",
          },
          401,
        );
      }
      c.set("sourceMapUploadProjectId", resolved.projectId);
      await next();
      return;
    }
    if (!isOrgManagementKey(token)) {
      return c.json(
        { error: "wrong credential type: /api/v1/* requires an sl_management_* key" },
        401,
      );
    }
    const resolved = await resolveOrgApiKey(token);
    if (!resolved) return c.json({ error: "invalid or revoked key" }, 401);
    c.set("managementOrgId", resolved.orgId);
    c.set("managementKeyId", resolved.id);
    await next();
  });

  app.post(
    "/api/v1/projects",
    describeRoute({
      tags: ["Projects"],
      summary: "Create a project",
      description:
        "Creates a new project in the authed org. Optionally mints an initial " +
        "ingest key in the same call (default behavior).",
      responses: {
        200: {
          description: "Project created",
          content: { "application/json": { schema: resolver(createProjectResponseSchema) } },
        },
        ...BAD_REQUEST,
        ...COMMON_ERRORS,
        ...CONFLICT,
      },
    }),
    validator("json", createProjectInputSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const body = c.req.valid("json");
      const name = body.name.trim();
      const slug = body.slug.trim().toLowerCase();

      const existing = await db.query.projects.findFirst({
        where: and(eq(schema.projects.orgId, orgId), eq(schema.projects.slug, slug)),
      });
      if (existing) throw new HTTPException(409, { message: "slug already in use in this org" });

      const [project] = await db
        .insert(schema.projects)
        .values({ orgId, name, slug, projectContext: body.project_context ?? "" })
        .returning();
      if (!project) throw new HTTPException(500, { message: "failed to create project" });

      // Seed automation settings row so the worker doesn't need to special-case
      // its absence (matches what ensureProjectForOrg does for the default).
      await db
        .insert(schema.projectAutomationSettings)
        .values({
          projectId: project.id,
          ...(body.automerge_fix_prs !== undefined
            ? { autoMergeFixPrs: body.automerge_fix_prs }
            : {}),
          ...(body.automerge_method !== undefined
            ? { autoMergeMethod: body.automerge_method }
            : {}),
          ...(body.pr_base_branch !== undefined
            ? { prBaseBranch: parsePrBaseBranch(body.pr_base_branch) }
            : {}),
        })
        .onConflictDoNothing({ target: schema.projectAutomationSettings.projectId });

      const automerge = await getAutomergeForProject(project.id);
      log.info(
        {
          org_id: orgId,
          project_id: project.id,
          slug: project.slug,
          mint_ingest_key: body.mint_ingest_key,
          automerge_fix_prs: automerge.automerge_fix_prs,
          automerge_method: automerge.automerge_method,
        },
        "project created via management api",
      );

      const projectPayload = {
        id: project.id,
        name: project.name,
        slug: project.slug,
        project_context: project.projectContext,
        automerge_fix_prs: automerge.automerge_fix_prs,
        automerge_method: automerge.automerge_method,
        pr_base_branch: automerge.pr_base_branch,
      };

      if (!body.mint_ingest_key) {
        return c.json({ project: projectPayload, api_key: null });
      }
      const minted = await mintApiKey({ projectId: project.id, name: "Initial ingest key" });
      return c.json({
        project: projectPayload,
        api_key: {
          id: minted.id,
          name: minted.name,
          key_prefix: minted.keyPrefix,
          plaintext: minted.plaintext,
        },
      });
    },
  );

  app.get(
    "/api/v1/projects",
    describeRoute({
      tags: ["Projects"],
      summary: "List projects in the org",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(projectListResponseSchema) } },
        },
        ...COMMON_ERRORS,
      },
    }),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const rows = await db.query.projects.findMany({
        where: eq(schema.projects.orgId, orgId),
        orderBy: [desc(schema.projects.createdAt)],
      });
      if (rows.length === 0) {
        return c.json({ projects: [] });
      }
      const automationRows = await db.query.projectAutomationSettings.findMany({
        where: inArray(
          schema.projectAutomationSettings.projectId,
          rows.map((p) => p.id),
        ),
      });
      const automationByProject = new Map(automationRows.map((r) => [r.projectId, r]));
      return c.json({
        projects: rows.map((p) => {
          const auto = automationByProject.get(p.id);
          return {
            id: p.id,
            name: p.name,
            slug: p.slug,
            project_context: p.projectContext,
            created_at: p.createdAt.toISOString(),
            automerge_fix_prs: auto?.autoMergeFixPrs ?? "never",
            automerge_method: auto?.autoMergeMethod ?? "squash",
            pr_base_branch: schema.normalizePrBaseBranch(auto?.prBaseBranch),
          };
        }),
      });
    },
  );

  app.get(
    "/api/v1/projects/:projectId",
    describeRoute({
      tags: ["Projects"],
      summary: "Get a project",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(projectResponseSchema) } },
        },
        ...COMMON_ERRORS,
        ...NOT_FOUND,
      },
    }),
    validator("param", projectIdParamSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      const project = await requireProjectInOrg(orgId, projectId);
      const automerge = await getAutomergeForProject(project.id);
      return c.json({
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
          project_context: project.projectContext,
          created_at: project.createdAt.toISOString(),
          automerge_fix_prs: automerge.automerge_fix_prs,
          automerge_method: automerge.automerge_method,
          pr_base_branch: automerge.pr_base_branch,
        },
      });
    },
  );

  app.patch(
    "/api/v1/projects/:projectId",
    describeRoute({
      tags: ["Projects"],
      summary: "Update a project",
      description: "Partial update. Only fields present in the body are written.",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(projectResponseSchema) } },
        },
        ...BAD_REQUEST,
        ...COMMON_ERRORS,
        ...NOT_FOUND,
        ...CONFLICT,
      },
    }),
    validator("param", projectIdParamSchema),
    validator("json", updateProjectInputSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      const project = await requireProjectInOrg(orgId, projectId);
      const body = c.req.valid("json");

      const projectPatch: Partial<typeof schema.projects.$inferInsert> = {};
      if (body.name !== undefined) projectPatch.name = body.name.trim();
      if (body.project_context !== undefined) projectPatch.projectContext = body.project_context;
      if (body.slug !== undefined) {
        const slug = body.slug.trim().toLowerCase();
        if (slug !== project.slug) {
          const clash = await db.query.projects.findFirst({
            where: and(eq(schema.projects.orgId, orgId), eq(schema.projects.slug, slug)),
          });
          if (clash) throw new HTTPException(409, { message: "slug already in use in this org" });
          projectPatch.slug = slug;
        }
      }

      let updatedProject = project;
      if (Object.keys(projectPatch).length > 0) {
        const [row] = await db
          .update(schema.projects)
          .set(projectPatch)
          .where(eq(schema.projects.id, project.id))
          .returning();
        if (!row) throw new HTTPException(404, { message: "project not found" });
        updatedProject = row;
      }

      const prBaseBranch = parsePrBaseBranch(body.pr_base_branch);
      if (
        body.automerge_fix_prs !== undefined ||
        body.automerge_method !== undefined ||
        prBaseBranch !== undefined
      ) {
        // Upsert so a project that somehow lacks an automation row still ends
        // up with one carrying the requested values; non-provided fields fall
        // back to schema defaults on insert and stay untouched on update.
        const updatedAt = new Date();
        await db
          .insert(schema.projectAutomationSettings)
          .values({
            projectId: project.id,
            ...(body.automerge_fix_prs !== undefined
              ? { autoMergeFixPrs: body.automerge_fix_prs }
              : {}),
            ...(body.automerge_method !== undefined
              ? { autoMergeMethod: body.automerge_method }
              : {}),
            ...(prBaseBranch !== undefined ? { prBaseBranch } : {}),
            updatedAt,
          })
          .onConflictDoUpdate({
            target: schema.projectAutomationSettings.projectId,
            set: {
              ...(body.automerge_fix_prs !== undefined
                ? { autoMergeFixPrs: body.automerge_fix_prs }
                : {}),
              ...(body.automerge_method !== undefined
                ? { autoMergeMethod: body.automerge_method }
                : {}),
              ...(prBaseBranch !== undefined ? { prBaseBranch } : {}),
              updatedAt,
            },
          });
      }

      const automerge = await getAutomergeForProject(project.id);
      log.info(
        {
          org_id: orgId,
          project_id: project.id,
          updated_fields: {
            name: projectPatch.name !== undefined,
            slug: projectPatch.slug !== undefined,
            project_context: projectPatch.projectContext !== undefined,
            automerge_fix_prs: body.automerge_fix_prs !== undefined,
            automerge_method: body.automerge_method !== undefined,
            pr_base_branch: prBaseBranch !== undefined,
          },
        },
        "project updated via management api",
      );

      return c.json({
        project: {
          id: updatedProject.id,
          name: updatedProject.name,
          slug: updatedProject.slug,
          project_context: updatedProject.projectContext,
          created_at: updatedProject.createdAt.toISOString(),
          automerge_fix_prs: automerge.automerge_fix_prs,
          automerge_method: automerge.automerge_method,
          pr_base_branch: automerge.pr_base_branch,
        },
      });
    },
  );

  app.post(
    "/api/v1/projects/:projectId/api-keys",
    describeRoute({
      tags: ["API keys"],
      summary: "Mint a new ingest API key",
      responses: {
        200: {
          description: "Key minted (plaintext shown once)",
          content: { "application/json": { schema: resolver(mintApiKeyResponseSchema) } },
        },
        ...COMMON_ERRORS,
        ...NOT_FOUND,
      },
    }),
    validator("param", projectIdParamSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      await requireProjectInOrg(orgId, projectId);
      // Body is optional; parse manually so callers can omit it entirely.
      const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "API key";
      const minted = await mintApiKey({ projectId, name });
      return c.json({
        api_key: {
          id: minted.id,
          name: minted.name,
          key_prefix: minted.keyPrefix,
          plaintext: minted.plaintext,
        },
      });
    },
  );

  app.get(
    "/api/v1/projects/:projectId/api-keys",
    describeRoute({
      tags: ["API keys"],
      summary: "List ingest API keys for a project",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(apiKeyListResponseSchema) } },
        },
        ...COMMON_ERRORS,
        ...NOT_FOUND,
      },
    }),
    validator("param", projectIdParamSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      await requireProjectInOrg(orgId, projectId);
      const rows = await db.query.apiKeys.findMany({
        where: eq(schema.apiKeys.projectId, projectId),
        orderBy: [desc(schema.apiKeys.createdAt)],
      });
      return c.json({
        api_keys: rows.map((k) => ({
          id: k.id,
          name: k.name,
          key_prefix: k.keyPrefix,
          last_used_at: k.lastUsedAt?.toISOString() ?? null,
          revoked_at: k.revokedAt?.toISOString() ?? null,
          created_at: k.createdAt.toISOString(),
        })),
      });
    },
  );

  app.post(
    "/api/v1/projects/:projectId/sourcemaps",
    describeRoute({
      tags: ["Projects"],
      summary: "Upload a source map artifact",
      description:
        "Uploads a compressed source map artifact for later issue symbolication. " +
        "Accepts either a project-scoped `sl_public_*` ingest key for this project " +
        "or a server-side `sl_management_*` key for the org.",
      responses: {
        200: {
          description: "Source map stored",
          content: { "application/json": { schema: resolver(okResponseSchema) } },
        },
        ...BAD_REQUEST,
        ...COMMON_ERRORS,
        ...NOT_FOUND,
      },
    }),
    validator("param", projectIdParamSchema),
    validator("json", sourceMapUploadSchema),
    async (c) => {
      const vars = c.var as MgmtVars;
      const { projectId } = c.req.valid("param");
      if (vars.sourceMapUploadProjectId) {
        if (vars.sourceMapUploadProjectId !== projectId) {
          throw new HTTPException(404, { message: "project not found" });
        }
      } else {
        if (!vars.managementOrgId || !vars.managementKeyId) {
          throw new HTTPException(401, { message: "missing upload authorization" });
        }
        await requireProjectInOrg(vars.managementOrgId, projectId);
      }
      if (!sourceMapObjectStore) {
        throw new HTTPException(503, {
          message: "source map storage is not configured",
        });
      }
      const artifact = await storeSourceMapArtifact({
        database: db,
        projectId,
        uploadedByOrgApiKeyId: vars.managementKeyId ?? null,
        objectStore: sourceMapObjectStore,
        input: c.req.valid("json"),
      });
      return c.json({
        ok: true,
        artifact: {
          id: artifact.id,
          project_id: artifact.projectId,
          platform: artifact.platform,
          release: artifact.release,
          dist: artifact.dist,
          debug_id: artifact.debugId,
          map_file: artifact.mapFile,
          source_map_hash: artifact.sourceMapHash,
          source_map_bytes: artifact.sourceMapBytes,
          storage_bucket: artifact.storageBucket,
          storage_key: artifact.storageKey,
          created_at: artifact.createdAt.toISOString(),
          updated_at: artifact.updatedAt.toISOString(),
        },
      });
    },
  );

  app.post(
    "/api/v1/integrations/github/install-url",
    describeRoute({
      tags: ["GitHub integration"],
      summary: "Mint an org-scoped GitHub App install URL",
      description:
        "Resulting install is owned by the org and can be granted to multiple " +
        "projects. `return_url` host must be in the org's allowlist.",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(installUrlResponseSchema) } },
        },
        ...BAD_REQUEST,
        ...COMMON_ERRORS,
        ...SERVICE_UNAVAILABLE,
      },
    }),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      // Body is optional; parse manually.
      const body = (await c.req.json().catch(() => ({}))) as { return_url?: unknown };
      const returnUrl = typeof body.return_url === "string" ? body.return_url : null;
      if (returnUrl) await assertReturnUrlAllowed(orgId, returnUrl);
      const result = buildGithubMgmtInstallUrl({ scope: "org", orgId, returnUrl });
      if (!result) throw new HTTPException(503, { message: "github app not configured" });
      log.info({ org_id: orgId, return_url: returnUrl }, "org-scoped github install url minted");
      return c.json({ install_url: result.url });
    },
  );

  app.post(
    "/api/v1/projects/:projectId/integrations/github/install-url",
    describeRoute({
      tags: ["GitHub integration"],
      summary: "Mint a project-scoped GitHub App install URL",
      description:
        "Resulting install is bound to one project and is NOT listed by " +
        "`GET /api/v1/integrations/github/installations`.",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(installUrlResponseSchema) } },
        },
        ...BAD_REQUEST,
        ...COMMON_ERRORS,
        ...NOT_FOUND,
        ...SERVICE_UNAVAILABLE,
      },
    }),
    validator("param", projectIdParamSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      await requireProjectInOrg(orgId, projectId);
      const body = (await c.req.json().catch(() => ({}))) as { return_url?: unknown };
      const returnUrl = typeof body.return_url === "string" ? body.return_url : null;
      if (returnUrl) await assertReturnUrlAllowed(orgId, returnUrl);
      const result = buildGithubMgmtInstallUrl({ scope: "project", projectId, returnUrl });
      if (!result) throw new HTTPException(503, { message: "github app not configured" });
      log.info(
        { org_id: orgId, project_id: projectId, return_url: returnUrl },
        "project-scoped github install url minted",
      );
      return c.json({ install_url: result.url });
    },
  );

  app.get(
    "/api/v1/integrations/github/installations",
    describeRoute({
      tags: ["GitHub integration"],
      summary: "List org-scoped GitHub installs",
      description: "Project-scoped installs and revoked / suspended installs are excluded.",
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: resolver(githubInstallationListResponseSchema),
            },
          },
        },
        ...COMMON_ERRORS,
      },
    }),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      return c.json(await listOrgScopedInstalls(orgId));
    },
  );

  app.get(
    "/api/v1/integrations/github/installations/:installationRowId/repos",
    describeRoute({
      tags: ["GitHub integration"],
      summary: "List repos an install covers (live)",
      description:
        "Live call to GitHub. Capped at 1000 repos; `truncated=true` means " +
        "more exist. You can still grant a beyond-cap repo by passing its " +
        "numeric ID to the grant endpoint (O(1) lookup).",
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: resolver(githubRepoListResponseSchema) },
          },
        },
        ...COMMON_ERRORS,
        ...NOT_FOUND,
        ...BAD_GATEWAY,
      },
    }),
    validator("param", installationRowIdParamSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { installationRowId } = c.req.valid("param");
      return c.json(await listOrgScopedInstallRepos(orgId, installationRowId));
    },
  );

  app.post(
    "/api/v1/projects/:projectId/github/repos",
    describeRoute({
      tags: ["GitHub integration"],
      summary: "Grant a project access to a repo",
      description:
        "Validates the install belongs to this org and the repo is covered " +
        "by it (live GitHub check) so a leaked management key can't grant " +
        "access to arbitrary repo IDs.",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(grantRepoResponseSchema) } },
        },
        ...BAD_REQUEST,
        ...COMMON_ERRORS,
        ...NOT_FOUND,
        ...BAD_GATEWAY,
      },
    }),
    validator("param", projectIdParamSchema),
    validator("json", grantRepoInputSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      const body = c.req.valid("json");
      return c.json(
        await grantRepoToProject({
          orgId,
          projectId,
          body: { installation_id: body.installation_id, repo_id: body.repo_id },
        }),
      );
    },
  );

  app.delete(
    "/api/v1/projects/:projectId/github/repos/:repoId",
    describeRoute({
      tags: ["GitHub integration"],
      summary: "Revoke a project's grant on a repo",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(okResponseSchema) } },
        },
        ...BAD_REQUEST,
        ...COMMON_ERRORS,
        ...NOT_FOUND,
      },
    }),
    validator("param", repoIdParamSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const keyId = (c.var as MgmtVars).managementKeyId;
      const { projectId, repoId } = c.req.valid("param");
      return c.json(
        await revokeProjectRepoGrant({
          orgId,
          projectId,
          repoIdParam: repoId,
          actor: { kind: "management_key", id: keyId },
        }),
      );
    },
  );

  app.get(
    "/api/v1/projects/:projectId/github/repos",
    describeRoute({
      tags: ["GitHub integration"],
      summary: "List repo grants on a project",
      description: "Grants whose underlying install has been revoked are filtered out.",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(grantListResponseSchema) } },
        },
        ...COMMON_ERRORS,
        ...NOT_FOUND,
      },
    }),
    validator("param", projectIdParamSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      return c.json(await listProjectGithubGrants(orgId, projectId));
    },
  );

  // ── Telemetry read API ──────────────────────────────────────────────────
  // Generic GET endpoints for reading traces / logs / metrics from a project.
  // Same auth as the rest of /api/v1/* (sl_management_* keys). Consumers
  // include the superlog-dialtone uptime monitor, but these are first-class
  // public endpoints — anyone with a management key can use them.

  app.get(
    "/api/v1/projects/:projectId/traces/:traceId",
    describeRoute({
      tags: ["Telemetry read"],
      summary: "Get a trace by id",
      description: "Returns all spans and correlated logs for the given trace.",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(telemetryReadResponseSchema) } },
        },
        ...COMMON_ERRORS,
        ...NOT_FOUND,
        ...BAD_REQUEST,
      },
    }),
    validator("param", traceByIdParamSchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId, traceId } = c.req.valid("param");
      await requireProjectInOrg(orgId, projectId);
      const detail = await getTraceDetail(chHeavy, projectId, traceId);
      const spans = (detail.spans as unknown[]) ?? [];
      if (spans.length === 0) throw new HTTPException(404, { message: "trace not found" });
      return c.json(detail);
    },
  );

  app.get(
    "/api/v1/projects/:projectId/logs",
    describeRoute({
      tags: ["Telemetry read"],
      summary: "Query logs",
      description:
        "Returns log rows filtered by any combination of trace_id, service, severity, " +
        "free-text search, and time range. Newest first.",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(telemetryReadResponseSchema) } },
        },
        ...COMMON_ERRORS,
        ...NOT_FOUND,
        ...BAD_REQUEST,
      },
    }),
    validator("param", projectIdParamSchema),
    validator("query", logsQuerySchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      const q = c.req.valid("query");
      await requireProjectInOrg(orgId, projectId);
      const items = await queryLogs(ch, projectId, {
        range: { since: q.from, until: q.to },
        service: q.service,
        severity: q.severity,
        search: q.search,
        traceId: q.trace_id,
        limit: q.limit,
      });
      return c.json({ items });
    },
  );

  app.get(
    "/api/v1/projects/:projectId/metrics",
    describeRoute({
      tags: ["Telemetry read"],
      summary: "Query metric data points",
      description:
        "Returns metric data points across sum/gauge/histogram tables, filtered by " +
        "metric name and (optionally) service / time range.",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: resolver(telemetryReadResponseSchema) } },
        },
        ...COMMON_ERRORS,
        ...NOT_FOUND,
        ...BAD_REQUEST,
      },
    }),
    validator("param", projectIdParamSchema),
    validator("query", metricsQuerySchema),
    async (c) => {
      const orgId = (c.var as MgmtVars).managementOrgId;
      const { projectId } = c.req.valid("param");
      const q = c.req.valid("query");
      await requireProjectInOrg(orgId, projectId);
      const rows = await queryMetrics(ch, projectId, {
        metricName: q.name,
        service: q.service,
        range: { since: q.from, until: q.to },
        limit: q.limit,
      });
      return c.json({ items: rows });
    },
  );
}

// Resolves an install row by UUID, ensures it belongs to the authed org AND
// is org-scoped (project_id NULL). Project-scoped installs are private to one
// project and never grantable to others.
async function requireOrgScopedInstall(
  orgId: string,
  installationRowId: string,
): Promise<schema.GithubInstallation> {
  const install = await db.query.githubInstallations.findFirst({
    where: eq(schema.githubInstallations.id, installationRowId),
  });
  // Same "not found" message regardless of why so we don't leak existence of
  // other orgs' installs.
  if (!install || install.orgId !== orgId || install.projectId !== null || install.revokedAt) {
    throw new HTTPException(404, { message: "org-scoped installation not found" });
  }
  return install;
}

// Shared helpers — called from both management-API (org-key) and dashboard
// (cookie-session) handlers so behavior stays in sync between the two surfaces.

async function listOrgScopedInstalls(orgId: string): Promise<{
  installations: {
    id: string;
    installation_id: number;
    account_login: string | null;
    account_type: string | null;
    created_at: string;
  }[];
}> {
  const rows = await db.query.githubInstallations.findMany({
    where: and(
      eq(schema.githubInstallations.orgId, orgId),
      isNull(schema.githubInstallations.projectId),
      isNull(schema.githubInstallations.revokedAt),
    ),
    orderBy: [desc(schema.githubInstallations.createdAt)],
  });
  return {
    installations: rows.map((r) => ({
      id: r.id,
      installation_id: r.installationId,
      account_login: r.accountLogin,
      account_type: r.accountType,
      created_at: r.createdAt.toISOString(),
    })),
  };
}

async function listOrgScopedInstallRepos(
  orgId: string,
  installationRowId: string,
): Promise<{
  repos: { id: number; full_name: string; private: boolean }[];
  truncated: boolean;
}> {
  const install = await requireOrgScopedInstall(orgId, installationRowId);
  try {
    const repos = await listCurrentInstallationRepos(install.installationId);
    // listCurrentInstallationRepos caps at 10 pages × 100 = 1000 repos.
    // If we hit exactly that, more pages likely exist — signal it.
    const truncated = repos.length >= 1000;
    return {
      repos: repos.map((r) => ({ id: r.id, full_name: r.fullName, private: r.private })),
      truncated,
    };
  } catch (err) {
    log.warn(
      { err, org_id: orgId, installation_row_id: installationRowId },
      "live github repo lookup failed",
    );
    throw new HTTPException(502, { message: "failed to fetch repos from github" });
  }
}

// Marks an org-scoped install row as revoked. Idempotent on already-revoked
// rows (returns ok). Does not touch the install on GitHub — operator follows
// up at github.com/settings/installations to fully uninstall if needed.
async function revokeOrgScopedInstallation(
  orgId: string,
  installationRowId: string,
): Promise<{ ok: true }> {
  const install = await requireOrgScopedInstall(orgId, installationRowId);
  await db
    .update(schema.githubInstallations)
    .set({ revokedAt: new Date() })
    .where(eq(schema.githubInstallations.id, install.id));
  log.info(
    { org_id: orgId, installation_row_id: install.id, installation_id: install.installationId },
    "org-scoped github installation revoked",
  );
  return { ok: true };
}

async function grantRepoToProject(args: {
  orgId: string;
  projectId: string;
  body: { installation_id?: unknown; repo_id?: unknown };
}): Promise<{
  grant: {
    id: string;
    installation_id: string;
    repo_id: number;
    repo_full_name: string;
    created_at: string;
  };
}> {
  const { orgId, projectId, body } = args;
  await requireProjectInOrg(orgId, projectId);
  if (typeof body.installation_id !== "string") {
    throw new HTTPException(400, { message: "installation_id (row UUID) is required" });
  }
  const repoId = Number(body.repo_id);
  if (!Number.isFinite(repoId) || repoId <= 0) {
    throw new HTTPException(400, { message: "repo_id must be a positive integer" });
  }
  const install = await requireOrgScopedInstall(orgId, body.installation_id);

  // Direct O(1) GitHub lookup — listCurrentInstallationRepos caps at 1000
  // repos, so a paginate-then-find approach would silently 404 valid repos
  // beyond that cap.
  let repo: Awaited<ReturnType<typeof fetchInstallationRepoById>>;
  try {
    repo = await fetchInstallationRepoById(install.installationId, repoId);
  } catch (err) {
    log.warn(
      { err, org_id: orgId, installation_id: install.installationId, repo_id: repoId },
      "github repo verification failed",
    );
    throw new HTTPException(502, { message: "failed to verify repo against github" });
  }
  if (!repo) {
    throw new HTTPException(404, { message: "repo not covered by this installation" });
  }

  const [row] = await db
    .insert(schema.projectGithubRepos)
    .values({
      projectId,
      installationId: install.id,
      githubRepoId: repo.id,
      githubRepoFullName: repo.fullName,
    })
    .onConflictDoUpdate({
      target: [schema.projectGithubRepos.projectId, schema.projectGithubRepos.githubRepoId],
      set: { installationId: install.id, githubRepoFullName: repo.fullName },
    })
    .returning();
  if (!row) throw new HTTPException(500, { message: "failed to record grant" });
  log.info(
    { org_id: orgId, project_id: projectId, repo_id: repo.id, repo: repo.fullName },
    "github repo granted to project",
  );
  return {
    grant: {
      id: row.id,
      installation_id: row.installationId,
      repo_id: row.githubRepoId,
      repo_full_name: row.githubRepoFullName,
      created_at: row.createdAt.toISOString(),
    },
  };
}

async function revokeProjectRepoGrant(args: {
  orgId: string;
  projectId: string;
  repoIdParam: string;
  actor: { kind: "management_key"; id: string } | { kind: "user"; id: string };
}): Promise<{ ok: true }> {
  const { orgId, projectId, repoIdParam, actor } = args;
  await requireProjectInOrg(orgId, projectId);
  const repoId = Number(repoIdParam);
  if (!Number.isFinite(repoId) || repoId <= 0) {
    throw new HTTPException(400, { message: "repoId must be a positive integer" });
  }
  const result = await db
    .delete(schema.projectGithubRepos)
    .where(
      and(
        eq(schema.projectGithubRepos.projectId, projectId),
        eq(schema.projectGithubRepos.githubRepoId, repoId),
      ),
    )
    .returning({
      id: schema.projectGithubRepos.id,
      repoFullName: schema.projectGithubRepos.githubRepoFullName,
      installationId: schema.projectGithubRepos.installationId,
    });
  if (result.length === 0) {
    throw new HTTPException(404, { message: "grant not found" });
  }
  const removed = result[0];
  if (!removed) {
    throw new HTTPException(404, { message: "grant not found" });
  }
  log.info(
    {
      org_id: orgId,
      project_id: projectId,
      repo_id: repoId,
      repo: removed.repoFullName,
      installation_id: removed.installationId,
      actor_kind: actor.kind,
      actor_id: actor.id,
    },
    "github repo grant revoked",
  );
  return { ok: true };
}

async function listGrantsForInstallation(
  orgId: string,
  installationRowId: string,
): Promise<{
  grants: {
    id: string;
    project_id: string;
    repo_id: number;
    repo_full_name: string;
    created_at: string;
  }[];
}> {
  // requireOrgScopedInstall asserts the install belongs to this org and is
  // org-scoped — otherwise we'd leak grants across orgs by row UUID.
  const install = await requireOrgScopedInstall(orgId, installationRowId);
  const rows = await db
    .select({
      id: schema.projectGithubRepos.id,
      projectId: schema.projectGithubRepos.projectId,
      githubRepoId: schema.projectGithubRepos.githubRepoId,
      githubRepoFullName: schema.projectGithubRepos.githubRepoFullName,
      createdAt: schema.projectGithubRepos.createdAt,
    })
    .from(schema.projectGithubRepos)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectGithubRepos.projectId))
    .where(
      and(
        eq(schema.projectGithubRepos.installationId, install.id),
        eq(schema.projects.orgId, orgId),
      ),
    )
    .orderBy(desc(schema.projectGithubRepos.createdAt));
  return {
    grants: rows.map((r) => ({
      id: r.id,
      project_id: r.projectId,
      repo_id: r.githubRepoId,
      repo_full_name: r.githubRepoFullName,
      created_at: r.createdAt.toISOString(),
    })),
  };
}

async function listProjectGithubGrants(
  orgId: string,
  projectId: string,
): Promise<{
  grants: {
    id: string;
    installation_id: string;
    repo_id: number;
    repo_full_name: string;
    created_at: string;
  }[];
}> {
  await requireProjectInOrg(orgId, projectId);
  const rows = await db
    .select({
      id: schema.projectGithubRepos.id,
      installationId: schema.projectGithubRepos.installationId,
      githubRepoId: schema.projectGithubRepos.githubRepoId,
      githubRepoFullName: schema.projectGithubRepos.githubRepoFullName,
      createdAt: schema.projectGithubRepos.createdAt,
    })
    .from(schema.projectGithubRepos)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.projectGithubRepos.installationId),
    )
    .where(
      and(
        eq(schema.projectGithubRepos.projectId, projectId),
        isNull(schema.githubInstallations.revokedAt),
      ),
    )
    .orderBy(desc(schema.projectGithubRepos.createdAt));
  return {
    grants: rows.map((r) => ({
      id: r.id,
      installation_id: r.installationId,
      repo_id: r.githubRepoId,
      repo_full_name: r.githubRepoFullName,
      created_at: r.createdAt.toISOString(),
    })),
  };
}

// Validates a customer-supplied return_url against the org's allowlist.
// Throws HTTPException(400) on any failure so the management API caller gets
// an actionable error.
//
// The management key alone is NOT sufficient to authorize a redirect — if
// it leaks, an attacker shouldn't be able to phish install completers off to
// arbitrary hosts. A dashboard admin must register each acceptable host on
// `orgs.allowed_return_url_hosts` first.
async function assertReturnUrlAllowed(orgId: string, returnUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new HTTPException(400, { message: "return_url is not a valid URL" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HTTPException(400, { message: "return_url must be http or https" });
  }
  if (parsed.username || parsed.password) {
    throw new HTTPException(400, { message: "return_url must not include credentials" });
  }
  const host = parsed.hostname.toLowerCase();
  const org = await db.query.orgs.findFirst({ where: eq(schema.orgs.id, orgId) });
  const allowed = (org?.allowedReturnUrlHosts ?? []).map((h) => h.toLowerCase());
  if (!allowed.includes(host)) {
    throw new HTTPException(400, {
      message: `return_url host "${host}" is not in this org's return URL allowlist`,
    });
  }
}

// Dashboard-facing endpoints for humans to mint/list/revoke org management
// keys. Mounted under the session-auth /api/* middleware.
// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountOrgKeyManagementAuthed(app: Hono<any>): void {
  app.get("/api/org/api-keys", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ keys: [] });
    const rows = await db.query.orgApiKeys.findMany({
      where: eq(schema.orgApiKeys.orgId, ctx.orgId),
      orderBy: [desc(schema.orgApiKeys.createdAt)],
    });
    return c.json({
      keys: rows.map((k) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.keyPrefix,
        last_used_at: k.lastUsedAt?.toISOString() ?? null,
        revoked_at: k.revokedAt?.toISOString() ?? null,
        created_at: k.createdAt.toISOString(),
      })),
    });
  });

  app.post("/api/org/api-keys", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "API key";
    const minted = await mintOrgApiKey({
      orgId: ctx.orgId,
      name,
      createdByUserId: ctx.userId,
    });
    log.info(
      { org_id: ctx.orgId, key_id: minted.id, created_by: ctx.userId, prefix: minted.keyPrefix },
      "org management key minted",
    );
    return c.json({
      key: {
        id: minted.id,
        name: minted.name,
        key_prefix: minted.keyPrefix,
        plaintext: minted.plaintext, // shown once
        created_at: minted.createdAt.toISOString(),
      },
    });
  });

  app.delete("/api/org/api-keys/:id", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    const id = c.req.param("id");
    // Scope by org_id so users can't revoke keys from other orgs by ID guess.
    const result = await db
      .update(schema.orgApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.orgApiKeys.id, id),
          eq(schema.orgApiKeys.orgId, ctx.orgId),
          isNull(schema.orgApiKeys.revokedAt),
        ),
      )
      .returning({ id: schema.orgApiKeys.id });
    if (result.length === 0) {
      // Either wrong org, wrong id, or already revoked — return 404 either way
      // so we don't leak existence of other orgs' keys.
      throw new HTTPException(404, { message: "key not found" });
    }
    return c.json({ ok: true });
  });

  // Allowlist of hostnames that management-API mint endpoints may use as
  // `return_url`. A human dashboard admin must register a host before a key
  // holder can ever redirect to it — closes the open-redirect path otherwise
  // available to anyone who obtains a management key.
  app.get("/api/org/return-url-hosts", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ hosts: [] });
    const org = await db.query.orgs.findFirst({ where: eq(schema.orgs.id, ctx.orgId) });
    return c.json({ hosts: org?.allowedReturnUrlHosts ?? [] });
  });

  app.put("/api/org/return-url-hosts", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    const body = (await c.req.json().catch(() => ({}))) as { hosts?: unknown };
    if (!Array.isArray(body.hosts)) {
      throw new HTTPException(400, { message: "hosts must be a string[]" });
    }
    const normalized: string[] = [];
    for (const raw of body.hosts) {
      if (typeof raw !== "string") {
        throw new HTTPException(400, { message: "hosts must be a string[]" });
      }
      const host = raw.trim().toLowerCase();
      if (!isValidHostname(host)) {
        throw new HTTPException(400, { message: `invalid hostname: ${raw}` });
      }
      if (!normalized.includes(host)) normalized.push(host);
    }
    await db
      .update(schema.orgs)
      .set({ allowedReturnUrlHosts: normalized })
      .where(eq(schema.orgs.id, ctx.orgId));
    log.info(
      { org_id: ctx.orgId, hosts: normalized, set_by: ctx.userId },
      "return URL allowlist updated",
    );
    return c.json({ hosts: normalized });
  });

  // Mints an org-scoped GitHub install URL the same way the management API
  // does, but auth-gated on a Better Auth session instead of an `sl_management_*`
  // key. Lets a dashboard admin set up the org-level GitHub install without
  // first minting a management key just to run one curl.
  app.post("/api/org/github/install-url", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    const result = buildGithubMgmtInstallUrl({
      scope: "org",
      orgId: ctx.orgId,
      returnUrl: null,
    });
    if (!result) throw new HTTPException(503, { message: "github app not configured" });
    log.info(
      { org_id: ctx.orgId, requested_by: ctx.userId },
      "org-scoped github install url minted via dashboard",
    );
    return c.json({ install_url: result.url });
  });

  // Session-authed twins of the org-scoped GitHub install + grant management
  // endpoints under /api/v1/*. The dashboard uses these so the user doesn't
  // need to mint a management key to manage installs/grants from the UI.
  app.get("/api/org/github/installations", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ installations: [] });
    return c.json(await listOrgScopedInstalls(ctx.orgId));
  });

  app.get("/api/org/github/installations/:rowId/repos", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    return c.json(await listOrgScopedInstallRepos(ctx.orgId, c.req.param("rowId")));
  });

  app.get("/api/org/github/installations/:rowId/grants", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    return c.json(await listGrantsForInstallation(ctx.orgId, c.req.param("rowId")));
  });

  app.delete("/api/org/github/installations/:rowId", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    return c.json(await revokeOrgScopedInstallation(ctx.orgId, c.req.param("rowId")));
  });

  app.get("/api/org/projects/:projectId/github/repos", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ grants: [] });
    return c.json(await listProjectGithubGrants(ctx.orgId, c.req.param("projectId")));
  });

  app.post("/api/org/projects/:projectId/github/repos", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    const body = (await c.req.json().catch(() => ({}))) as {
      installation_id?: unknown;
      repo_id?: unknown;
    };
    return c.json(
      await grantRepoToProject({ orgId: ctx.orgId, projectId: c.req.param("projectId"), body }),
    );
  });

  app.delete("/api/org/projects/:projectId/github/repos/:repoId", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) throw new HTTPException(404, { message: "no org for user" });
    return c.json(
      await revokeProjectRepoGrant({
        orgId: ctx.orgId,
        projectId: c.req.param("projectId"),
        repoIdParam: c.req.param("repoId"),
        actor: { kind: "user", id: ctx.userId },
      }),
    );
  });
}

// RFC 1123 hostname validation. No leading/trailing dot, no double dots, each
// label is 1-63 alphanumeric chars + interior hyphens, total length ≤253.
function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
  const labelRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  return host.split(".").every((label) => labelRe.test(label));
}

async function requireProjectInOrg(orgId: string, projectId: string): Promise<schema.Project> {
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
  });
  if (!project) throw new HTTPException(404, { message: "project not found" });
  if (project.orgId !== orgId) {
    throw new HTTPException(404, { message: "project not found" });
  }
  return project;
}

async function resolveUserOrg(
  c: Context<{ Variables: DashboardVars }>,
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
