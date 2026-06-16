import {
  type PatExpiryChoice,
  db,
  isPatExpiryChoice,
  mintPersonalAccessToken,
  schema,
} from "@superlog/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";
import { assertProjectAccess, listAccessibleProjects } from "./mcp/projects.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "personal-access-tokens" });

const NAME_MAX_LEN = 120;

type Vars = { userId: string; orgId: string | null };

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountPersonalAccessTokens(app: Hono<any>): void {
  // List the caller's MCP personal access tokens (never returns plaintext).
  app.get("/api/me/mcp-tokens", async (c) => {
    const userId = (c.var as Vars).userId;
    const rows = await db.query.personalAccessTokens.findMany({
      where: eq(schema.personalAccessTokens.userId, userId),
      orderBy: [desc(schema.personalAccessTokens.createdAt)],
    });
    const projectNames = new Map(
      (await listAccessibleProjects(userId)).map((p) => [
        p.id,
        { name: p.name, orgName: p.orgName },
      ]),
    );
    return c.json({
      tokens: rows.map((t) => ({
        id: t.id,
        name: t.name,
        tokenPrefix: t.tokenPrefix,
        projectId: t.projectId,
        projectName: projectNames.get(t.projectId)?.name ?? null,
        orgName: projectNames.get(t.projectId)?.orgName ?? null,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        expiresAt: t.expiresAt?.toISOString() ?? null,
        revokedAt: t.revokedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  });

  // Mint a new token. The plaintext is returned exactly once here and never
  // again — the client must capture it now.
  app.post("/api/me/mcp-tokens", async (c) => {
    const userId = (c.var as Vars).userId;
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      projectId?: unknown;
      expiry?: unknown;
    };

    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, NAME_MAX_LEN)
        : "MCP token";

    const expiry: PatExpiryChoice = isPatExpiryChoice(body.expiry) ? body.expiry : "never";

    const projectId = await resolveProjectId(c, userId, body.projectId);

    const minted = await mintPersonalAccessToken({ userId, projectId, name, expiry });
    log.info(
      { user_id: userId, project_id: projectId, token_id: minted.id, prefix: minted.tokenPrefix },
      "personal access token minted",
    );
    return c.json({
      token: {
        id: minted.id,
        name: minted.name,
        tokenPrefix: minted.tokenPrefix,
        plaintext: minted.plaintext, // shown once
        projectId: minted.projectId,
        expiresAt: minted.expiresAt?.toISOString() ?? null,
        createdAt: minted.createdAt.toISOString(),
      },
    });
  });

  // Revoke a token. Scoped to the caller so IDs from other users can't be
  // revoked by guessing — a miss returns 404 without leaking existence.
  app.delete("/api/me/mcp-tokens/:id", async (c) => {
    const userId = (c.var as Vars).userId;
    const id = c.req.param("id");
    const result = await db
      .update(schema.personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.personalAccessTokens.id, id),
          eq(schema.personalAccessTokens.userId, userId),
          isNull(schema.personalAccessTokens.revokedAt),
        ),
      )
      .returning({ id: schema.personalAccessTokens.id });
    if (result.length === 0) throw new HTTPException(404, { message: "token not found" });
    return c.json({ ok: true });
  });
}

// Resolve which project the token defaults to. An explicit, accessible
// project_id wins. Otherwise we only auto-pick when the caller's active org has
// exactly one project — with several, the choice would be arbitrary, so make
// the client pass projectId rather than silently binding to a non-deterministic
// one.
async function resolveProjectId(c: Context, userId: string, raw: unknown): Promise<string> {
  if (typeof raw === "string" && raw.trim()) {
    const projectId = raw.trim();
    await assertProjectAccess(userId, projectId);
    return projectId;
  }
  const ctx = await resolveActiveOrgContext({
    userId,
    preferredOrgId: (c.var as Vars).orgId,
  }).catch(() => null);
  if (!ctx) throw new HTTPException(400, { message: "projectId is required" });
  const orgProjects = (await listAccessibleProjects(userId)).filter((p) => p.orgId === ctx.org.id);
  const only = orgProjects[0];
  if (!only) throw new HTTPException(400, { message: "no project available; pass projectId" });
  if (orgProjects.length > 1) {
    throw new HTTPException(400, { message: "multiple projects in org; pass projectId" });
  }
  return only.id;
}
