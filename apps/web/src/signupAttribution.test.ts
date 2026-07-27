import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_TOUCH_STORAGE_KEY,
  buildSignupEventProperties,
  clickIdsFromAttribution,
  parseAttribution,
  persistFirstTouchAttribution,
  readFirstTouchAttribution,
  readPosthogClientIds,
  serializeClickIdsCookie,
  serializeSignupAttributionCookie,
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

test("parseAttribution captures ad-network click ids", () => {
  const attr = parseAttribution(
    "?twclid=tw123&gclid=gg456&fbclid=fb789&msclkid=ms012&li_fat_id=li345",
    "",
  );
  assert.equal(attr.twclid, "tw123");
  assert.equal(attr.gclid, "gg456");
  assert.equal(attr.fbclid, "fb789");
  assert.equal(attr.msclkid, "ms012");
  assert.equal(attr.liFatId, "li345");
});

test("a click id alone is enough signal to persist first-touch", () => {
  // A paid click may land with only a click id and no UTM parameters. It must
  // persist so conversion and analytics attribution survive the OAuth round-trip.
  const store = fakeStorage();
  persistFirstTouchAttribution(store, { twclid: "tw123" });
  assert.equal(readFirstTouchAttribution(store)?.twclid, "tw123");
});

test("buildSignupEventProperties surfaces click ids for PostHog breakdowns", () => {
  // Analytics breakdowns can identify the source from the populated click-id field.
  const props = buildSignupEventProperties({ twclid: "tw123", gclid: "gg456" }, {});
  assert.equal(props.twclid, "tw123");
  assert.equal(props.gclid, "gg456");
});

test("clickIdsFromAttribution collects present click ids keyed by param name", () => {
  assert.deepEqual(clickIdsFromAttribution({ twclid: "tw123", source: "web" }), {
    twclid: "tw123",
  });
  assert.deepEqual(clickIdsFromAttribution({ source: "web" }), {});
});

test("serializeClickIdsCookie yields JSON when present, null when empty", () => {
  assert.equal(serializeClickIdsCookie({ twclid: "tw123" }), JSON.stringify({ twclid: "tw123" }));
  assert.equal(serializeClickIdsCookie({ source: "web" }), null);
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

test("serializeSignupAttributionCookie carries props and posthog ids", () => {
  const value = serializeSignupAttributionCookie(
    { utm_source: "x", utm_medium: "paid_social" },
    { distinctId: "anon-123", sessionId: "sess-456" },
  );
  assert.ok(value);
  assert.deepEqual(JSON.parse(value), {
    props: { utm_source: "x", utm_medium: "paid_social" },
    ph: { did: "anon-123", sid: "sess-456" },
  });
});

test("serializeSignupAttributionCookie omits empty props and absent ids", () => {
  const value = serializeSignupAttributionCookie({}, { sessionId: "sess-456" });
  assert.ok(value);
  assert.deepEqual(JSON.parse(value), { ph: { sid: "sess-456" } });
});

test("serializeSignupAttributionCookie drops blank posthog ids", () => {
  const value = serializeSignupAttributionCookie({ utm_source: "x" }, { distinctId: "" });
  assert.ok(value);
  assert.deepEqual(JSON.parse(value), { props: { utm_source: "x" } });
});

test("serializeSignupAttributionCookie yields null when there is nothing to carry", () => {
  assert.equal(serializeSignupAttributionCookie({}, {}), null);
});

test("serializeSignupAttributionCookie truncates oversized values instead of dropping them", () => {
  // The server drops any value longer than 256 chars, so the client must
  // truncate (an unbounded landing pathname would otherwise kill the field).
  const value = serializeSignupAttributionCookie({ landing_path: "/" + "x".repeat(400) }, {});
  assert.ok(value);
  const parsed = JSON.parse(value) as { props: Record<string, string> };
  assert.equal(parsed.props.landing_path?.length, 256);
});

test("serializeSignupAttributionCookie keeps the payload under the cookie size budget", () => {
  const long = (c: string) => c.repeat(256);
  const props: Record<string, string> = {
    utm_source: long("a"),
    utm_medium: long("b"),
    utm_campaign: long("c"),
    signup_source: long("d"),
    referring_domain: long("e"),
    auth_method: long("f"),
    twclid: long("g"),
    gclid: long("h"),
    fbclid: long("i"),
    msclkid: long("j"),
    li_fat_id: long("k"),
    utm_term: long("l"),
    utm_content: long("m"),
    landing_path: long("n"),
    referrer: long("o"),
  };
  const value = serializeSignupAttributionCookie(props, {
    distinctId: "anon-123",
    sessionId: "sess-456",
  });
  assert.ok(value);
  assert.ok(encodeURIComponent(value).length <= 3072, "encoded cookie must fit the budget");
  const parsed = JSON.parse(value) as { props: Record<string, string>; ph: { did: string } };
  // The ids and the highest-priority channel fields must survive the trim;
  // the long free-text tail (referrer) is what gets dropped.
  assert.equal(parsed.ph.did, "anon-123");
  assert.equal(parsed.props.utm_source, long("a"));
  assert.equal(parsed.props.referrer, undefined);
});

test("readPosthogClientIds returns both ids for an anonymous browser", () => {
  const ids = readPosthogClientIds({
    get_distinct_id: () => "anon-123",
    get_session_id: () => "sess-456",
    get_property: () => "anonymous",
  });
  assert.deepEqual(ids, { distinctId: "anon-123", sessionId: "sess-456" });
});

test("readPosthogClientIds omits the distinct id when the browser is already identified", () => {
  // A stale identified state (previous account, expired server session) must
  // not be aliased onto a new signup — that would merge two real users.
  const ids = readPosthogClientIds({
    get_distinct_id: () => "previous-user-id",
    get_session_id: () => "sess-456",
    get_property: (key: string) => (key === "$user_state" ? "identified" : undefined),
  });
  assert.deepEqual(ids, { distinctId: undefined, sessionId: "sess-456" });
});

test("readPosthogClientIds tolerates a missing or throwing posthog", () => {
  assert.deepEqual(readPosthogClientIds(null), {
    distinctId: undefined,
    sessionId: undefined,
  });
  assert.deepEqual(
    readPosthogClientIds({
      get_distinct_id: () => {
        throw new Error("not booted");
      },
      get_session_id: () => {
        throw new Error("not booted");
      },
    }),
    { distinctId: undefined, sessionId: undefined },
  );
});
