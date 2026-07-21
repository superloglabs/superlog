import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  type ActorAuditDeps,
  type ActorSession,
  type ActorVars,
  createAuthActorAuditMiddleware,
} from "./request-actor-log.js";

const SESSION: ActorSession = {
  user: { id: "user_1", name: "Nicolo Magnante", email: "nicolo@superlog.sh" },
  session: { id: "sess_1", activeOrganizationId: "org_1", impersonatedBy: null },
};

function buildApp(overrides: Partial<ActorAuditDeps> = {}, throwStatus?: number) {
  const logs: Record<string, unknown>[] = [];
  let getSessionCalls = 0;
  let sawVars: { userId?: string; orgId: string | null } | undefined;

  const deps: ActorAuditDeps = {
    getSession: async () => {
      getSessionCalls++;
      return SESSION;
    },
    resolveOrg: async () => ({ name: "Superlog prod", slug: "swish" }),
    log: (fields) => logs.push(fields),
    onError: (err) => {
      throw err;
    },
    ...overrides,
  };

  const app = new Hono<{ Variables: ActorVars }>();
  // Mimics the HTTP-observability middleware: registered first, reads c.var
  // after the chain resolves.
  app.use("/api/auth/*", async (c, next) => {
    await next();
    sawVars = { userId: c.get("userId"), orgId: c.get("orgId") };
  });
  app.use("/api/auth/*", createAuthActorAuditMiddleware(deps));
  // Mimics Better Auth's handler: either returns an error response or throws
  // an HTTPException (e.g. invalid input), depending on the test.
  app.on(["POST", "GET"], "/api/auth/*", (c) => {
    if (throwStatus) throw new HTTPException(throwStatus as 400, { message: "boom" });
    return c.json({ error: "denied" }, 403);
  });

  return { app, logs, getSessionCalls: () => getSessionCalls, sawVars: () => sawVars };
}

test("audits a mutating auth route and still reaches the terminating handler", async () => {
  const h = buildApp();
  const res = await h.app.request("/api/auth/organization/update-member-role", { method: "POST" });

  assert.equal(res.status, 403, "Better Auth handler still produces the response");
  assert.equal(h.logs.length, 1);
  assert.deepEqual(h.logs[0], {
    method: "POST",
    path: "/api/auth/organization/update-member-role",
    status: 403,
    userId: "user_1",
    userName: "Nicolo Magnante",
    userEmail: "nicolo@superlog.sh",
    orgId: "org_1",
    orgName: "Superlog prod",
    orgSlug: "swish",
    sessionId: "sess_1",
    impersonating: false,
    impersonatedBy: null,
  });
  // Identity is stamped for the observability span to pick up.
  assert.deepEqual(h.sawVars(), { userId: "user_1", orgId: "org_1" });
});

test("attributes an impersonated mutation to the real staff user", async () => {
  const h = buildApp({
    getSession: async () => ({
      user: { id: "customer_1", name: "Customer", email: "customer@acme.com" },
      session: { id: "sess_2", activeOrganizationId: "org_1", impersonatedBy: "staff_9" },
    }),
  });
  await h.app.request("/api/auth/organization/update-member-role", { method: "POST" });

  const [entry] = h.logs;
  assert.ok(entry);
  assert.equal(entry.userId, "customer_1");
  assert.equal(entry.impersonatedBy, "staff_9");
  assert.equal(entry.impersonating, true);
});

test("skips reads without resolving a session (no double get-session lookup)", async () => {
  const h = buildApp();
  const res = await h.app.request("/api/auth/get-session", { method: "GET" });

  assert.equal(res.status, 403);
  assert.equal(h.logs.length, 0, "reads are not audited");
  assert.equal(h.getSessionCalls(), 0, "reads do not trigger our extra getSession");
});

test("mutating auth route with no session passes through unlogged (sign-in/sign-up)", async () => {
  const h = buildApp({ getSession: async () => null });
  const res = await h.app.request("/api/auth/sign-in/email", { method: "POST" });

  assert.equal(res.status, 403);
  assert.equal(h.logs.length, 0);
  assert.equal(h.sawVars()?.userId, undefined, "no identity stamped without a session");
});

test("audits a mutation that fails by throwing, with the thrown status", async () => {
  const h = buildApp({}, 400);
  const res = await h.app.request("/api/auth/organization/update-member-role", { method: "POST" });

  assert.equal(res.status, 400, "the thrown HTTPException still produces the response");
  const [entry] = h.logs;
  assert.ok(entry, "a throwing mutation is still attributed");
  assert.equal(entry.status, 400);
  assert.equal(entry.userId, "user_1");
});

test("a logging failure never breaks the request", async () => {
  const h = buildApp({
    resolveOrg: async () => {
      throw new Error("db down");
    },
    onError: () => {}, // swallow, as the production logger.warn does
  });
  const res = await h.app.request("/api/auth/organization/update-member-role", { method: "POST" });

  assert.equal(res.status, 403, "request succeeds even when audit logging throws");
  assert.equal(h.logs.length, 0);
});
