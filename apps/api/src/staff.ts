import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

// Staff gate. The admin product surface (org overview, evals, feedback triage)
// is no longer part of open core, but two staff capabilities remain here:
// surfacing `isStaff` on /api/me and the impersonation user picker. Both need
// this check, so it lives in its own small module rather than the (removed)
// admin router.
//
// Staff is anyone whose user row has "admin" in the Better Auth admin plugin's
// `role` column (comma-separated list). Grant/revoke at runtime via SQL or
// `authClient.admin.setRole` — no redeploy required.
export function userIsStaff(role: string | null | undefined): boolean {
  if (!role) return false;
  return role.split(",").some((r) => r.trim() === "admin");
}

export async function isStaff(userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  // Banned admins lose access here too — Better Auth's session middleware
  // already gates banned users, but defense-in-depth in case that gate is
  // ever bypassed or misconfigured.
  if (!user || user.banned) return false;
  return userIsStaff(user.role);
}

export async function requireStaff(userId: string): Promise<void> {
  if (!(await isStaff(userId))) {
    throw new HTTPException(403, { message: "admin access required" });
  }
}
