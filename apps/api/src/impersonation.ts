import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { requireStaff } from "./staff.js";

type Vars = { userId: string; orgId: string | null };

// Minimal staff-only user picker for the impersonation command-palette flow.
// The actual impersonation is performed by Better Auth's admin plugin
// (authClient.admin.impersonateUser); this endpoint only supplies the list of
// candidate users + the orgs they belong to so the palette can search them.
// It deliberately exposes nothing beyond what a user picker needs — no usage
// metrics, no per-org analytics (that lives in the private admin app).
export function mountImpersonation(app: Hono<{ Variables: Vars }>): void {
  app.get("/api/admin/impersonation-targets", async (c) => {
    await requireStaff(c.var.userId);
    const rows = await db
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        orgName: schema.orgs.name,
        orgSlug: schema.orgs.slug,
      })
      .from(schema.orgMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId));

    // Collapse to one row per user; carry the orgs they belong to so the
    // palette can match on either a person or a company.
    const byUser = new Map<
      string,
      { userId: string; email: string; name: string | null; orgs: { name: string; slug: string }[] }
    >();
    for (const r of rows) {
      const existing = byUser.get(r.userId);
      if (existing) {
        existing.orgs.push({ name: r.orgName, slug: r.orgSlug });
      } else {
        byUser.set(r.userId, {
          userId: r.userId,
          email: r.email,
          name: r.name,
          orgs: [{ name: r.orgName, slug: r.orgSlug }],
        });
      }
    }
    return c.json({ users: Array.from(byUser.values()) });
  });
}
