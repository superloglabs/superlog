import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_TOUCH_STORAGE_KEY,
  buildSignupEventProperties,
  parseAttribution,
  persistFirstTouchAttribution,
  readFirstTouchAttribution,
} from "./signupAttribution.ts";

// A tiny in-memory localStorage stand-in so the storage helpers can be tested
// without a DOM. Mirrors the subset of the Web Storage API we use.
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    get size() {
      return map.size;
    },
  };
}

test("parseAttribution extracts a valid source param", () => {
  const attr = parseAttribution("?source=Skill", "");
  assert.equal(attr.source, "skill"); // normalized to lower-case
});

test("parseAttribution rejects an out-of-range / malformed source", () => {
  assert.equal(parseAttribution("?source=not a source!", "").source, undefined);
  assert.equal(parseAttribution(`?source=${"x".repeat(40)}`, "").source, undefined);
  assert.equal(parseAttribution("", "").source, undefined);
});

test("parseAttribution pulls all UTM fields", () => {
  const attr = parseAttribution(
    "?utm_source=twitter&utm_medium=social&utm_campaign=launch&utm_term=obs&utm_content=hero",
    "",
  );
  assert.equal(attr.utmSource, "twitter");
  assert.equal(attr.utmMedium, "social");
  assert.equal(attr.utmCampaign, "launch");
  assert.equal(attr.utmTerm, "obs");
  assert.equal(attr.utmContent, "hero");
});

test("parseAttribution derives referrer and referring domain", () => {
  const attr = parseAttribution("", "https://news.ycombinator.com/item?id=1");
  assert.equal(attr.referrer, "https://news.ycombinator.com/item?id=1");
  assert.equal(attr.referringDomain, "news.ycombinator.com");
});

test("parseAttribution ignores a same-origin / empty referrer for the domain", () => {
  const attr = parseAttribution("", "");
  assert.equal(attr.referrer, undefined);
  assert.equal(attr.referringDomain, undefined);
});

test("persistFirstTouchAttribution is write-once (first touch wins)", () => {
  const store = fakeStorage();
  persistFirstTouchAttribution(store, { source: "skill", utmSource: "twitter" });
  // A later visit with different params must NOT overwrite the first touch.
  persistFirstTouchAttribution(store, { source: "web", utmSource: "google" });
  const got = readFirstTouchAttribution(store);
  assert.equal(got?.source, "skill");
  assert.equal(got?.utmSource, "twitter");
});

test("persistFirstTouchAttribution does not write an all-empty attribution", () => {
  const store = fakeStorage();
  persistFirstTouchAttribution(store, {});
  assert.equal(store.getItem(FIRST_TOUCH_STORAGE_KEY), null);
});

test("persistFirstTouchAttribution ignores a landingPath-only touch (no signal)", () => {
  // landingPath is always present (pathname is at least "/"), so it must not be
  // treated as signal — otherwise the first plain pageview would lock in and shut
  // out a later attributed landing.
  const store = fakeStorage();
  persistFirstTouchAttribution(store, { landingPath: "/explore" });
  assert.equal(store.getItem(FIRST_TOUCH_STORAGE_KEY), null);
});

test("persistFirstTouchAttribution stores landingPath alongside real signal", () => {
  const store = fakeStorage();
  // First, an unattributed pageview — not persisted.
  persistFirstTouchAttribution(store, { landingPath: "/" });
  // Then a real attributed landing — persisted, carrying its landingPath.
  persistFirstTouchAttribution(store, { source: "skill", landingPath: "/explore" });
  const got = readFirstTouchAttribution(store);
  assert.equal(got?.source, "skill");
  assert.equal(got?.landingPath, "/explore");
});

test("readFirstTouchAttribution returns null on missing / corrupt JSON", () => {
  assert.equal(readFirstTouchAttribution(fakeStorage()), null);
  assert.equal(
    readFirstTouchAttribution(fakeStorage({ [FIRST_TOUCH_STORAGE_KEY]: "{not json" })),
    null,
  );
});

test("readFirstTouchAttribution drops non-string and unknown values from tampered storage", () => {
  const store = fakeStorage({
    [FIRST_TOUCH_STORAGE_KEY]: JSON.stringify({
      source: "skill",
      utmSource: 123, // wrong type
      referrer: { nested: true }, // wrong type
      injected: "evil", // unknown key
    }),
  });
  const got = readFirstTouchAttribution(store);
  assert.deepEqual(got, { source: "skill" });
});

test("buildSignupEventProperties emits snake_case keys and omits undefined", () => {
  const props = buildSignupEventProperties(
    { source: "skill", utmSource: "twitter", referringDomain: "t.co" },
    { authMethod: "email" },
  );
  assert.deepEqual(props, {
    signup_source: "skill",
    utm_source: "twitter",
    referring_domain: "t.co",
    auth_method: "email",
  });
});

test("buildSignupEventProperties yields an empty object for empty inputs", () => {
  assert.deepEqual(buildSignupEventProperties({}, {}), {});
});
