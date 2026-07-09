import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLOUDFLARE_OAUTH_TOKEN_URL } from "@superlog/cloudflare";
import {
  type CloudflareInstallationTokens,
  type CloudflareRefreshInstallation,
  type CloudflareRefreshedTokens,
  type CloudflareRefresherStore,
  runCloudflareRefreshOnce,
} from "./refresher.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const CONFIG = { clientId: "cid", clientSecret: "cs" };
const LOGGER = { info() {}, warn() {}, error() {} };

// A stored row the fake store exposes to the locked callback.
type Row = {
  accountId: string;
  refreshToken: string | null;
  // Expired long ago by default so the keep-alive always refreshes it.
  tokenExpiresAt: Date | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    accountId: "acct-1",
    refreshToken: "rt-old",
    tokenExpiresAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    ...overrides,
  };
}

type SavedTokens = { id: string } & CloudflareRefreshedTokens;

// Fake store: `withLockedInstallation` simulates the lock as a pass-through,
// re-reads from the in-memory rows, and lets `save` optionally throw (DB
// outage) to exercise the abort path.
function fakeStore(
  rowsById: Record<string, Row>,
  opts: { throwOnSave?: boolean } = {},
): { store: CloudflareRefresherStore; saved: SavedTokens[] } {
  const saved: SavedTokens[] = [];
  return {
    saved,
    store: {
      async listActiveInstallations(): Promise<CloudflareRefreshInstallation[]> {
        return Object.entries(rowsById).map(([id, r]) => ({
          id,
          accountId: r.accountId,
          hasRefreshToken: r.refreshToken != null,
        }));
      },
      async withLockedInstallation(installationId, fn) {
        const r = rowsById[installationId] ?? null;
        const current: CloudflareInstallationTokens | null = r
          ? { refreshToken: r.refreshToken, tokenExpiresAt: r.tokenExpiresAt }
          : null;
        const save = async (tokens: CloudflareRefreshedTokens): Promise<void> => {
          if (opts.throwOnSave) throw new Error("db down");
          saved.push({ id: installationId, ...tokens });
        };
        return fn(current, save);
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

test("refreshes an active install under the lock and persists the rotated pair + new expiry", async () => {
  const { store, saved } = fakeStore({ "inst-1": row() });
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
  const { store, saved } = fakeStore({ "inst-1": row({ refreshToken: null }) });
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

test("leaves a token another actor just refreshed (still fresh under the lock)", async () => {
  const { store, saved } = fakeStore({
    "inst-1": row({ tokenExpiresAt: new Date(NOW.getTime() + 10 * 60 * 60 * 1000) }),
  });
  const { fetchImpl, calls } = fakeTokenFetch({ json: {} });
  const stats = await runCloudflareRefreshOnce({
    store,
    config: CONFIG,
    log: LOGGER,
    fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(stats, { installations: 1, refreshed: 0, skipped: 1, errors: 0 });
  assert.equal(calls.length, 0); // never redeemed — no double rotation
  assert.equal(saved.length, 0);
});

test("keeps the existing refresh token when the response does not rotate it", async () => {
  const { store, saved } = fakeStore({ "inst-1": row() });
  const { fetchImpl } = fakeTokenFetch({ json: { access_token: "at-new", expires_in: 57600 } });
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

test("a rejected refresh is isolated and doesn't block other installs", async () => {
  const { store, saved } = fakeStore({
    dead: row({ refreshToken: "rt-dead" }),
    live: row({ refreshToken: "rt-live" }),
  });
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    return call === 1
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : new Response(
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
});

test("a thrown fetch on one install doesn't abort the pass", async () => {
  const { store, saved } = fakeStore({
    boom: row({ refreshToken: "rt-boom" }),
    live: row({ refreshToken: "rt-live" }),
  });
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
});

test("a saveTokens failure aborts the pass (never rotate-and-lose across installs)", async () => {
  // A refresh rotates the token on Cloudflare's side; if the save then fails
  // (DB outage), continuing would rotate every remaining install and lose each
  // replacement. So the pass must abort after the first save failure.
  const { store } = fakeStore(
    { a: row(), b: row({ refreshToken: "rt-b" }) },
    { throwOnSave: true },
  );
  const { fetchImpl, calls } = fakeTokenFetch({
    json: { access_token: "at", refresh_token: "rt2", expires_in: 57600 },
  });
  await assert.rejects(
    runCloudflareRefreshOnce({ store, config: CONFIG, log: LOGGER, fetchImpl, now: () => NOW }),
    /db down/,
  );
  // Only the first install's token was requested; the pass aborted before the second.
  assert.equal(calls.length, 1);
});
