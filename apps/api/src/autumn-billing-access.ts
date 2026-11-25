import { db, schema } from "@superlog/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { canManageOrg } from "./org-authorization.js";

// Autumn's Better Auth routes bill the session's active org. These only read
// its billing. Every other Autumn route changes it: the plan, the
// subscription, the payment method, the portal, or referral codes.
const READ_ROUTES = new Set([
  "/autumn/aggregateEvents",
  "/autumn/getEntity",
  "/autumn/getOrCreateCustomer",
  "/autumn/listEvents",
  "/autumn/listPlans",
  "/autumn/previewAttach",
  "/autumn/previewMultiAttach",
  "/autumn/previewUpdateSubscription",
]);

export function autumnRouteChangesBilling(path: string): boolean {
  return !READ_ROUTES.has(path);
}

type OrgRole = (userId: string, orgId: string) => Promise<string | null>;

async function orgRole(userId: string, orgId: string): Promise<string | null> {
  const membership = await db.query.orgMembers.findFirst({
    where: and(eq(schema.orgMembers.userId, userId), eq(schema.orgMembers.orgId, orgId)),
    columns: { role: true },
  });
  return membership?.role ?? null;
}

// Members of the active org can read its billing. Only owners and admins can
// change it.
export async function authorizeAutumnRequest(
  request: { activeOrgId: string | null; path: string; userId: string | null },
  role: OrgRole = orgRole,
): Promise<void> {
  const current =
    request.userId && request.activeOrgId ? await role(request.userId, request.activeOrgId) : null;
  if (!current) {
    throw new APIError("FORBIDDEN", { message: "You are not a member of the active org" });
  }
  if (autumnRouteChangesBilling(request.path) && !canManageOrg(current)) {
    throw new APIError("FORBIDDEN", { message: "Only org owners and admins can change billing" });
  }
}

// Runs before each Autumn route, on the path Better Auth routed, so the check
// sees the same route and org the Autumn plugin acts on.
export function autumnBillingAccess(): BetterAuthPlugin {
  return {
    id: "autumn-billing-access",
    hooks: {
      before: [
        {
          matcher: (context) => context.path?.startsWith("/autumn/") ?? false,
          handler: createAuthMiddleware(async (context) => {
            const session = await getSessionFromCtx(context);
            const activeOrgId = (
              session?.session as { activeOrganizationId?: string | null } | undefined
            )?.activeOrganizationId;
            await authorizeAutumnRequest({
              activeOrgId: activeOrgId ?? null,
              path: context.path,
              userId: session?.user.id ?? null,
            });
          }),
        },
      ],
    },
  };
}
