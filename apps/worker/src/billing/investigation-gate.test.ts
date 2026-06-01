import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutumnInvestigationGate, createInvestigationGate } from "./investigation-gate.js";

type Call = { url: string; body: unknown };

function fakeFetch(responder: (url: string) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const { status, json } = responder(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("no AUTUMN_SECRET_KEY → allow-all gate (dev/worktrees never blocked)", async () => {
  const gate = createInvestigationGate({} as NodeJS.ProcessEnv);
  assert.equal(await gate.canRunInvestigation("org_1"), true);
  await gate.recordInvestigation("org_1"); // no throw
});

test("canRunInvestigation reads allowed and posts org as customer_id", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, json: { allowed: true } }));
  const gate = createAutumnInvestigationGate({ secretKey: "am_sk_test_x", fetchImpl: impl });
  assert.equal(await gate.canRunInvestigation("org_42"), true);
  assert.match(calls[0]!.url, /\/check$/);
  assert.deepEqual(calls[0]!.body, { customer_id: "org_42", feature_id: "investigations" });
});

test("allowed:false blocks (free tier exhausted)", async () => {
  const { impl } = fakeFetch(() => ({ status: 200, json: { allowed: false } }));
  const gate = createAutumnInvestigationGate({ secretKey: "k", fetchImpl: impl });
  assert.equal(await gate.canRunInvestigation("org_1"), false);
});

test("check fails OPEN on API error (billing outage must not block investigations)", async () => {
  const { impl } = fakeFetch(() => ({ status: 500, json: { error: "boom" } }));
  const gate = createAutumnInvestigationGate({ secretKey: "k", fetchImpl: impl });
  assert.equal(await gate.canRunInvestigation("org_1"), true);
});

test("recordInvestigation tracks value 1 for the org", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, json: { ok: true } }));
  const gate = createAutumnInvestigationGate({ secretKey: "k", fetchImpl: impl });
  await gate.recordInvestigation("org_7");
  assert.match(calls[0]!.url, /\/track$/);
  assert.deepEqual(calls[0]!.body, { customer_id: "org_7", feature_id: "investigations", value: 1 });
});

test("recordInvestigation swallows API errors (no throw)", async () => {
  const { impl } = fakeFetch(() => ({ status: 500, json: {} }));
  const gate = createAutumnInvestigationGate({ secretKey: "k", fetchImpl: impl });
  await gate.recordInvestigation("org_1"); // must not throw
});
