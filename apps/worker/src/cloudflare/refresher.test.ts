import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLOUDFLARE_OAUTH_TOKEN_URL } from "@superlog/cloudflare";
import {
  type CloudflareRefreshInstallation,
  type CloudflareRefresherStore,
  runCloudflareRefreshOnce,
} from "./refresher.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const CONFIG = { clientId: "cid", clientSecret: "cs" };
const LOGGER = { info() {}, warn() {}, error() {} };

function installation(
  overrides: Partial<CloudflareRefreshInstallation> = {},
): CloudflareRefreshInstallation {
  return {
    id: "inst-1",
    projectId: "superlog-project",
    accountId: "acct-1",
    refreshToken: "rt-old",
    ...overrides,
  };
}

type SavedTokens = {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
};

function fakeStore(rows: CloudflareRefreshInstallation[]): {
  store: CloudflareRefresherStore;
  saved: SavedTokens[];
} {
  const saved: SavedTokens[] = [];
  return {
    saved,
    store: {
      async listActiveInstallations() {
        return rows;
      },
      async saveTokens(id, tokens) {
        saved.push({ id, ...tokens });
      },
    },
  };
}

// Fake token endpoint: records calls, returns the configured JSON body.
function fakeTokenFetch(response: { status?: number; json: unknown }) {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), CLOUDFLARE_OAUTH_TOKEN_URL);
    calls.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(response.json), { status: response.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("refreshes every active install and persists the rotated pair + new expiry", async () => {
  const { store, saved } = fakeStore([installation()]);
  const { fetchImpl, calls } = fakeTokenFetch({
    json: { access_token: "at-new", refresh_token: "rt-new", expires_in: 57600 },
  });
  const stats = await runCloudflareRefreshOnce({
    store,
    config: CONFIG,
    log: LOGGER,
    fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(stats, { installations: 1, refreshed: 1, skipped: 0, errors: 0 });
  assert.equal(calls[0]?.get("grant_type"), "refresh_token");
  assert.equal(calls[0]?.get("refresh_token"), "rt-old");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.accessToken, "at-new");
  assert.equal(saved[0]?.refreshToken, "rt-new");
  assert.equal(saved[0]?.tokenExpiresAt?.getTime(), NOW.getTime() + 57600 * 1000);
});

test("skips a legacy install with no refresh token — needs reconnect", async () => {
  const { store, saved } = fakeStore([installation({ refreshToken: null })]);
  const { fetchImpl, calls } = fakeTokenFetch({ json: {} });
  const stats = await runCloudflareRefreshOnce({
    store,
    config: CONFIG,
    log: LOGGER,
    fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(stats, { installations: 1, refreshed: 0, skipped: 1, errors: 0 });
  assert.equal(calls.length, 0);
  assert.equal(saved.length, 0);
});

test("keeps the existing refresh token when the response does not rotate it", async () => {
  const { store, saved } = fakeStore([installation()]);
  const { fetchImpl } = fakeTokenFetch({
    json: { access_token: "at-new", expires_in: 57600 },
  });
  const stats = await runCloudflareRefreshOnce({
    store,
    config: CONFIG,
    log: LOGGER,
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(stats.refreshed, 1);
  assert.equal(saved[0]?.refreshToken, "rt-old");
});

test("counts an error and saves nothing when a refresh is rejected, without blocking others", async () => {
  // First install's refresh fails (dead grant); the second still refreshes.
  const rows = [installation({ id: "dead" }), installation({ id: "live", refreshToken: "rt-2" })];
  const { store, saved } = fakeStore(rows);
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    return call === 1
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : new Response(
          JSON.stringify({ access_token: "at-2", refresh_token: "rt-2b", expires_in: 57600 }),
          {
            status: 200,
          },
        );
  }) as typeof fetch;
  const stats = await runCloudflareRefreshOnce({
    store,
    config: CONFIG,
    log: LOGGER,
    fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(stats, { installations: 2, refreshed: 1, skipped: 0, errors: 1 });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.id, "live");
});

test("a thrown fetch on one install doesn't abort the pass", async () => {
  // First install's token request throws (network blip); the second still refreshes.
  const rows = [installation({ id: "boom" }), installation({ id: "live", refreshToken: "rt-2" })];
  const { store, saved } = fakeStore(rows);
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    if (call === 1) throw new Error("network down");
    return new Response(
      JSON.stringify({ access_token: "at-2", refresh_token: "rt-2b", expires_in: 57600 }),
      { status: 200 },
    );
  }) as typeof fetch;
  const stats = await runCloudflareRefreshOnce({
    store,
    config: CONFIG,
    log: LOGGER,
    fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(stats, { installations: 2, refreshed: 1, skipped: 0, errors: 1 });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.id, "live");
});
