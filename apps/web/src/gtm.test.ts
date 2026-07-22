import assert from "node:assert/strict";
import test from "node:test";
import { gtmLoaderSrc, initGtm } from "./gtm.ts";

// A tiny stand-in for the pieces of the DOM `initGtm` touches, so the injection
// behaviour can be tested under `node --test` without a real document.
function fakeDocument() {
  const scripts: FakeScript[] = [];
  const byId = new Map<string, FakeScript>();
  const head = {
    firstChild: null as FakeScript | null,
    insertBefore(node: FakeScript, _ref: FakeScript | null) {
      scripts.unshift(node);
      this.firstChild = node;
      if (node.id) byId.set(node.id, node);
      return node;
    },
  };
  return {
    scripts,
    head,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (_tag: string): FakeScript => ({ id: "", async: false, src: "" }),
  };
}

interface FakeScript {
  id: string;
  async: boolean;
  src: string;
}

test("gtmLoaderSrc builds the container loader URL and encodes the id", () => {
  assert.equal(
    gtmLoaderSrc("GTM-ABC123"),
    "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123",
  );
  assert.equal(
    gtmLoaderSrc("a&b"),
    "https://www.googletagmanager.com/gtm.js?id=a%26b",
  );
});

test("initGtm is a no-op when no container id is configured", () => {
  const doc = fakeDocument();
  const dataLayer: unknown[] = [];
  assert.equal(initGtm(undefined, { doc: doc as unknown as Document, dataLayer }), false);
  assert.equal(initGtm("", { doc: doc as unknown as Document, dataLayer }), false);
  assert.equal(doc.scripts.length, 0);
  assert.equal(dataLayer.length, 0);
});

test("initGtm pushes the start event and injects the loader once", () => {
  const doc = fakeDocument();
  const dataLayer: unknown[] = [];

  assert.equal(initGtm("GTM-ABC123", { doc: doc as unknown as Document, dataLayer, now: 42 }), true);
  assert.equal(doc.scripts.length, 1);
  const injected = doc.scripts[0]!;
  assert.equal(injected.src, "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123");
  assert.equal(injected.async, true);
  assert.deepEqual(dataLayer[0], { "gtm.start": 42, event: "gtm.js" });

  // Re-running (e.g. HMR) must not inject a second loader.
  assert.equal(initGtm("GTM-ABC123", { doc: doc as unknown as Document, dataLayer, now: 99 }), false);
  assert.equal(doc.scripts.length, 1);
  assert.equal(dataLayer.length, 1);
});
