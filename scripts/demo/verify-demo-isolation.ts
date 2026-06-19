// Adversarial integration check for demo-mode tenant isolation.
//
// Demo mode serves un-ingested users a shared, hidden demo project's data via a
// server-side read-only overlay (see apps/api/src/demo.ts). The invariant this
// script defends: a real user can NEVER read or write the demo project directly,
// mint credentials scoped to it, join its org, reach it via the management API,
// or learn its id from a response. The only way to see demo data is the overlay
// on your OWN un-ingested project.
//
// Unlike the pure unit tests (apps/api/src/demo.test.ts), these invariants depend
// on org membership + Better Auth + the management API, so this runs against the
// LIVE stack. Run from a seeded worktree:
//
//   DEMO_PROJECT_ID=<id> API_URL=<https://api...> DATABASE_URL=<pg> \
//     pnpm tsx scripts/demo/verify-demo-isolation.ts
//
// Exits non-zero (and prints BREACH) if any vector succeeds. Read-only probing.

import process from "node:process";

const API = (process.env.API_URL ?? "https://api.gifted-beechnut.superlog.localhost:1355").replace(
  /\/$/,
  "",
);
const ORIGIN = process.env.WEB_ORIGIN ?? API.replace("://api.", "://");
const DEMO_PROJECT = process.env.DEMO_PROJECT_ID;
if (!DEMO_PROJECT) throw new Error("DEMO_PROJECT_ID is required");

// The local portless API serves a self-signed cert, so accept it — but ONLY for
// loopback / *.localhost targets, never for a real host (so this can't weaken a
// production TLS connection). Against a real host (e.g. api.superlog.sh) we do
// nothing and let fetch verify the cert normally.
const apiHost = new URL(API).hostname;
const isLocalHost =
  apiHost === "127.0.0.1" || apiHost === "localhost" || apiHost.endsWith(".localhost");
if (isLocalHost) {
  // codeql[js/disabling-certificate-validation] -- localhost-only dev probe vs self-signed portless cert
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// --- tiny cookie jar over fetch ------------------------------------------------
const jar = new Map<string, string>();
function storeCookies(res: Response) {
  // node returns folded set-cookie via getSetCookie()
  const raw = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}
function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function req(
  method: string,
  path: string,
  opts: { body?: unknown; bearer?: string; auth?: boolean } = {},
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN };
  if (opts.auth !== false && jar.size) headers.cookie = cookieHeader();
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  storeCookies(res);
  return { status: res.status, text: await res.text() };
}

// --- assertions ----------------------------------------------------------------
let failures = 0;
const denied = (s: number) => s === 401 || s === 403 || s === 404;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "BREACH"}  ${name} — ${detail}`);
  if (!ok) failures++;
}

async function demoOrgId(): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  const { db } = await import("../../packages/db/src/client.js");
  const schema = await import("../../packages/db/src/schema.js");
  const { eq } = await import("drizzle-orm");
  const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, DEMO_PROJECT) });
  return p?.orgId ?? null;
}

async function main(): Promise<void> {
  const demoOrg = await demoOrgId();

  // Fresh attacker with their own (un-ingested → demoMode) project.
  const email = `isolation-probe-${Date.now()}@example.com`;
  await req("POST", "/api/auth/sign-up/email", {
    body: { email, password: "adminadmin", name: "Probe" },
  });
  await req("POST", "/api/me/orgs", { body: { name: "Probe Co" } });
  const me = JSON.parse((await req("GET", "/api/me")).text) as {
    demoMode?: boolean;
    project?: { id: string };
  };
  const myProject = me.project?.id;
  if (!myProject) throw new Error("probe user has no project");
  check("baseline: attacker is in demo mode", me.demoMode === true, `demoMode=${me.demoMode}`);

  // 1. Direct reads of the demo project by id.
  for (const sub of ["incidents", "dashboards", "issues"]) {
    const r = await req("GET", `/api/projects/${DEMO_PROJECT}/${sub}`);
    check(`direct read demo ${sub}`, denied(r.status), `http=${r.status}`);
  }
  const exploreLogs = await req("POST", `/api/projects/${DEMO_PROJECT}/explore/logs`, { body: {} });
  check("direct read demo explore/logs", denied(exploreLogs.status), `http=${exploreLogs.status}`);

  // 2. Direct writes to the demo project by id.
  for (const [m, sub, body] of [
    ["POST", "keys", '"x"'],
    ["POST", "dashboards", { name: "x", slug: "x" }],
  ] as const) {
    const r = await req(m, `/api/projects/${DEMO_PROJECT}/${sub}`, { body });
    check(`direct write demo ${sub}`, denied(r.status), `http=${r.status}`);
  }

  // 3. Mint credentials scoped to the demo project.
  const k = await req("POST", `/api/projects/${DEMO_PROJECT}/keys`, { body: '"x"' });
  check("mint ingest key for demo project", denied(k.status), `http=${k.status}`);
  const t = await req("POST", "/api/me/mcp-tokens", {
    body: { projectId: DEMO_PROJECT, name: "x" },
  });
  check("mint MCP token for demo project", denied(t.status), `http=${t.status}`);

  // 4. Activate / join the demo org.
  const act = await req("PUT", "/api/me/active-project", { body: { projectId: DEMO_PROJECT } });
  check("set active project to demo", denied(act.status), `http=${act.status}`);
  if (demoOrg) {
    const sa = await req("POST", "/api/auth/organization/set-active", {
      body: { organizationId: demoOrg },
    });
    check("Better Auth set-active demo org", denied(sa.status), `http=${sa.status}`);
    const inv = await req("POST", "/api/auth/organization/invite-member", {
      body: { organizationId: demoOrg, email, role: "owner" },
    });
    check(
      "Better Auth invite-self to demo org",
      !(inv.status >= 200 && inv.status < 300),
      `http=${inv.status}`,
    );
  }

  // 5. Management API: own key must not reach the demo project.
  const mk = await req("POST", "/api/org/api-keys", { body: { name: "mk" } });
  let mgmtToken: string | undefined;
  try {
    mgmtToken = JSON.parse(mk.text)?.key?.plaintext;
  } catch {
    /* ignore */
  }
  if (mgmtToken) {
    const sane = await req("GET", "/api/v1/projects", { bearer: mgmtToken, auth: false });
    check("mgmt key reads own projects (sanity)", sane.status === 200, `http=${sane.status}`);
    const breach = await req("GET", `/api/v1/projects/${DEMO_PROJECT}/api-keys`, {
      bearer: mgmtToken,
      auth: false,
    });
    check("mgmt key reaches demo project", denied(breach.status), `http=${breach.status}`);
  } else {
    check("obtained management key", false, "could not parse management key");
  }

  // 6. Demo id must never leak into overlaid responses on the attacker's project.
  for (const path of [
    `/api/projects/${myProject}/incidents`,
    `/api/projects/${myProject}/dashboards`,
    "/api/me",
  ]) {
    const r = await req("GET", path);
    check(`no demo-id leak in ${path}`, !r.text.includes(DEMO_PROJECT), `http=${r.status}`);
  }

  // 7. Read-only enforcement on the attacker's own (demo-overlaid) project.
  const w = await req("POST", `/api/projects/${myProject}/dashboards`, {
    body: { name: "x", slug: "x" },
  });
  check("write to own demo-overlaid dashboards is blocked", w.status === 403, `http=${w.status}`);
  const ok = await req("POST", `/api/projects/${myProject}/keys`, { body: '"leave-demo"' });
  check(
    "install path (mint own key) stays open",
    ok.status >= 200 && ok.status < 300,
    `http=${ok.status}`,
  );

  console.log(
    `\n${failures === 0 ? "✓ all isolation checks passed" : `✗ ${failures} BREACH(es) found`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
