import { strict as assert } from "node:assert";
import { test } from "node:test";
import { reconcileWorkerWiring } from "./observability.js";

// A fetch stub that answers the three Workers endpoints reconcile touches:
//   GET  …/workers/scripts                       → the script list
//   GET  …/workers/scripts/:s/settings           → that script's observability
//   PATCH …/workers/scripts/:s/settings          → apply new observability
// `settings` maps script id → its current observability block (or undefined).
function fakeCloudflare(input: {
  scripts: string[];
  settings: Record<string, unknown>;
  patchFails?: Set<string>;
  readFails?: Set<string>;
}) {
  const patched: { script: string }[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.endsWith("/workers/scripts")) {
      return json({ success: true, result: input.scripts.map((id) => ({ id })) });
    }
    const m = u.match(/\/workers\/scripts\/([^/]+)\/settings$/);
    if (m) {
      const script = decodeURIComponent(m[1] ?? "");
      if (method === "PATCH") {
        patched.push({ script });
        if (input.patchFails?.has(script)) {
          return json({ success: false, errors: [{ message: "nope" }] }, 400);
        }
        return json({ success: true });
      }
      if (input.readFails?.has(script)) return json({ success: false }, 500);
      return json({ success: true, result: { observability: input.settings[script] } });
    }
    throw new Error(`unexpected url ${u}`);
  }) as typeof fetch;
  return { fetchImpl, patched };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SLUGS = { traces: "trc-slug", logs: "log-slug" };

test("reconcileWorkerWiring wires only the drifted workers", async () => {
  // one already fully wired, one unwired, one brand-new (no observability).
  const wired = {
    enabled: true,
    traces: { enabled: true, destinations: ["trc-slug"] },
    logs: { enabled: true, destinations: ["log-slug"] },
  };
  const { fetchImpl, patched } = fakeCloudflare({
    scripts: ["already-wired", "drifted", "fresh"],
    settings: { "already-wired": wired, drifted: { enabled: true }, fresh: undefined },
  });

  const res = await reconcileWorkerWiring({
    accountId: "acc",
    accessToken: "tok",
    slugs: SLUGS,
    fetchImpl,
  });

  assert.equal(res.scripts, 3);
  assert.equal(res.wired, 2); // drifted + fresh; already-wired skipped (no PATCH)
  assert.deepEqual(patched.map((p) => p.script).sort(), ["drifted", "fresh"]);
});

test("reconcileWorkerWiring is per-worker isolated and never throws on failures", async () => {
  const { fetchImpl, patched } = fakeCloudflare({
    scripts: ["ok", "read-fails", "patch-fails"],
    settings: { ok: { enabled: false }, "patch-fails": { enabled: false } },
    readFails: new Set(["read-fails"]),
    patchFails: new Set(["patch-fails"]),
  });

  const res = await reconcileWorkerWiring({
    accountId: "acc",
    accessToken: "tok",
    slugs: SLUGS,
    fetchImpl,
  });

  assert.equal(res.scripts, 3);
  assert.equal(res.wired, 1); // only "ok" succeeded; the other two failed but didn't throw
  assert.ok(patched.some((p) => p.script === "ok"));
});

test("reconcileWorkerWiring is a no-op when no destination slugs exist", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return json({ success: true, result: [] });
  }) as typeof fetch;

  const res = await reconcileWorkerWiring({
    accountId: "acc",
    accessToken: "tok",
    slugs: {},
    fetchImpl,
  });

  assert.deepEqual(res, { scripts: 0, wired: 0, listOk: true });
  assert.equal(called, false); // short-circuits before hitting Cloudflare
});

test("reconcileWorkerWiring reports listOk:false when the scripts list fails", async () => {
  // GET /workers/scripts returns a non-OK / unsuccessful envelope.
  const fetchImpl = (async (url: unknown) => {
    if (String(url).endsWith("/workers/scripts")) {
      return json({ success: false, errors: [{ message: "unauthorized" }] }, 403);
    }
    throw new Error("should not reach per-script reads");
  }) as typeof fetch;

  const res = await reconcileWorkerWiring({
    accountId: "acc",
    accessToken: "tok",
    slugs: SLUGS,
    fetchImpl,
  });

  assert.deepEqual(res, { scripts: 0, wired: 0, listOk: false });
});
