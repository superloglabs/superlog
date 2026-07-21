import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

// Actor attribution for authenticated API requests.
//
// Every state-changing API request should be traceable back to the user and org
// that made it. The HTTP-observability span carries the opaque `enduser.id` /
// `tenant.org.id`, but an operator investigating a failure (e.g. a denied member
// role update) wants human-readable identity without a follow-up DB query. This
// builds the structured fields for that audit log line; the caller resolves the
// org name and emits it via the shared logger.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether an HTTP method mutates server state. Only mutating requests are
 * audit-logged — reads (GET/HEAD/OPTIONS) would drown the log in volume and
 * aren't "who did what" material.
 */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

// Project-scoped POST endpoints that are semantically reads — they carry query
// filters in the body. The demo read-only guard (demo.ts) excludes the same
// set; keep the two in sync.
const POST_READ_SUBPATHS = new Set(["issues/lookup", "issue-filter/preview", "alerts/preview"]);

/**
 * Is this a POST that's really a read (Explore queries, lookups, previews)?
 * Used to keep normal dashboard/query traffic out of the mutation audit — it
 * would otherwise flood the log and do a per-query org lookup.
 */
export function isReadOnlyPostPath(path: string): boolean {
  const sub = path.match(/^\/api\/projects\/[^/]+\/(.+?)(?:\?.*)?$/)?.[1];
  if (!sub) return false;
  return sub.startsWith("explore/") || POST_READ_SUBPATHS.has(sub);
}

/** A request worth auditing: a genuine state change, not a POST-for-read query. */
export function isAuditableMutation(args: { method: string; path: string }): boolean {
  return isMutatingMethod(args.method) && !isReadOnlyPostPath(args.path);
}

/**
 * Response status to attribute a mutation to when the handler threw before
 * producing a response — mirrors the HTTP-observability middleware so a failed
 * write (e.g. an HTTPException on invalid input) is still audited, not dropped.
 */
export function statusFromThrown(err: unknown): number {
  return err instanceof HTTPException ? err.status : 500;
}

/** Minimal shape of a resolved Better Auth session used for attribution. */
export type ActorSession = {
  user: { id: string; name?: string | null; email?: string | null };
  session: {
    id: string;
    activeOrganizationId?: string | null;
    impersonatedBy?: unknown;
  };
};

export type ActorAuditDeps = {
  /** Resolve the session for a request, or null when unauthenticated. */
  getSession: (headers: Headers) => Promise<ActorSession | null>;
  /** Look up a human-readable org name/slug for the log, or null if unknown. */
  resolveOrg: (orgId: string) => Promise<{ name: string | null; slug: string | null } | null>;
  /** Emit the structured audit line. */
  log: (fields: Record<string, unknown>) => void;
  /** Report a logging failure without throwing into the request. */
  onError: (err: unknown, path: string) => void;
};

/** Context vars this middleware stamps for downstream span attribution. */
export type ActorVars = {
  userId: string;
  sessionId?: string;
  orgId: string | null;
  impersonating?: boolean;
};

/**
 * Attribute a resolved session to the audit log. Shared by the /api/auth/*
 * middleware and the main session middleware so both emit identical fields.
 */
export async function writeActorAuditLog(
  deps: Pick<ActorAuditDeps, "resolveOrg" | "log" | "onError">,
  session: ActorSession,
  method: string,
  path: string,
  status: number,
): Promise<void> {
  try {
    const orgId = session.session.activeOrganizationId ?? null;
    const org = orgId ? await deps.resolveOrg(orgId) : null;
    deps.log(
      buildActorLogFields({
        method,
        path,
        status,
        userId: session.user.id,
        userName: session.user.name,
        userEmail: session.user.email,
        orgId,
        orgName: org?.name ?? null,
        orgSlug: org?.slug ?? null,
        sessionId: session.session.id,
        impersonatedBy:
          typeof session.session.impersonatedBy === "string"
            ? session.session.impersonatedBy
            : null,
      }),
    );
  } catch (err) {
    deps.onError(err, path);
  }
}

/**
 * Middleware for Better Auth's /api/auth/* routes. Those are terminated by
 * Better Auth's own handler, so the main session middleware never sees them.
 * This resolves the session best-effort for mutating requests, stamps identity
 * onto the context (for span attribution), and audit-logs after the handler.
 * Reads are passed straight through so we don't double the session lookup on
 * the hot get-session poll. Must be registered before the auth handler mount.
 *
 * The logged org is the actor's *active* org at request time. A few Better Auth
 * flows target a different org (accepting an invitation before setActive, or
 * passing an explicit organizationId), so this is best-effort context, not a
 * guarantee of the mutated org — the user is always attributed correctly.
 */
export function createAuthActorAuditMiddleware(
  deps: ActorAuditDeps,
): MiddlewareHandler<{ Variables: ActorVars }> {
  return async (c, next) => {
    if (!isAuditableMutation({ method: c.req.method, path: c.req.path })) return next();
    const session = await deps.getSession(c.req.raw.headers);
    if (session) {
      c.set("userId", session.user.id);
      c.set("sessionId", session.session.id);
      c.set("orgId", session.session.activeOrganizationId ?? null);
      c.set("impersonating", typeof session.session.impersonatedBy === "string");
    }
    // Audit in a finally so mutations that fail by throwing (not just those that
    // return an error response) are still attributed, then rethrow.
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } catch (err) {
      status = statusFromThrown(err);
      throw err;
    } finally {
      if (session) {
        await writeActorAuditLog(deps, session, c.req.method, c.req.path, status);
      }
    }
  };
}

export type ActorLogFieldsInput = {
  method: string;
  path: string;
  status: number;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  orgSlug?: string | null;
  sessionId?: string | null;
  /** The real staff user id when this request is an impersonation, else null. */
  impersonatedBy?: string | null;
};

/**
 * Build the structured fields for the actor audit log line. Pure: the caller
 * feeds it session-derived identity plus the resolved org name/slug.
 */
export function buildActorLogFields(input: ActorLogFieldsInput): Record<string, unknown> {
  const impersonatedBy = input.impersonatedBy ?? null;
  return {
    method: input.method.toUpperCase(),
    path: input.path,
    status: input.status,
    userId: input.userId,
    userName: input.userName ?? null,
    userEmail: input.userEmail ?? null,
    orgId: input.orgId ?? null,
    orgName: input.orgName ?? null,
    orgSlug: input.orgSlug ?? null,
    sessionId: input.sessionId ?? null,
    // When a staff user is impersonating, userId is the impersonated customer;
    // impersonatedBy is the real actor, so keep it for attribution.
    impersonating: impersonatedBy !== null,
    impersonatedBy,
  };
}
