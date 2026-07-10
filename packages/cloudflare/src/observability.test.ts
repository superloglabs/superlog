import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listScripts, listScriptsStrict, reconcileWorkerWiring } from "./observability.js";

// A fetch stub that answers the three Workers endpoints reconcile touches:
//   GET  …/workers/scripts?per_page&page       → the (paginated) script list
//   GET  …/workers/scripts/:s/settings         → that script's observability
//   PATCH …/workers/scripts/:s/settings        → apply new observability
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
    if (new URL(u).pathname.endsWith("/workers/scripts")) {
      // Single page (no result_info → the pager stops after one request).
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
    if (new URL(String(url)).pathname.endsWith("/workers/scripts")) {
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

// A paged /workers/scripts fake: `pages` is the list of id-arrays per page,
// each carrying result_info.total_pages so the lister keeps following pages.
function pagedScriptsFetch(pages: string[][], failPage?: number) {
  const requested: number[] = [];
  const fetchImpl = (async (url: unknown) => {
    const parsed = new URL(String(url));
    const page = Number(parsed.searchParams.get("page") ?? "1");
    requested.push(page);
    if (failPage != null && page === failPage) return json({ success: false }, 500);
    const result = (pages[page - 1] ?? []).map((id) => ({ id }));
    return json({
      success: true,
      result,
      result_info: { page, per_page: result.length, total_pages: pages.length },
    });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

test("listScripts follows pagination across all pages", async () => {
  const { fetchImpl, requested } = pagedScriptsFetch([["a", "b"], ["c", "d"], ["e"]]);
  const ids = await listScripts("acc", "tok", fetchImpl);
  assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(requested, [1, 2, 3]); // fetched every page
});

test("listScriptsStrict throws when a later page fails", async () => {
  const { fetchImpl } = pagedScriptsFetch([["a"], ["b"], ["c"]], 2);
  await assert.rejects(listScriptsStrict("acc", "tok", fetchImpl), /list worker scripts failed/);
});

test("listScripts returns the pages it got before a later page fails (tolerant)", async () => {
  const { fetchImpl } = pagedScriptsFetch([["a", "b"], ["c"]], 2);
  const ids = await listScripts("acc", "tok", fetchImpl);
  assert.deepEqual(ids, ["a", "b"]); // page 1 kept, failed page 2 stops the loop
});
