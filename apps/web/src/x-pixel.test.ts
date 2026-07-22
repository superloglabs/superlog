import assert from "node:assert/strict";
import test from "node:test";
import { initXPixel } from "./x-pixel.ts";

// A tiny stand-in for the pieces of the DOM `initXPixel` touches, so the
// injection behaviour can be tested under `node --test` without a real document.
function fakeEnv() {
  const scripts: FakeScript[] = [];
  const byId = new Map<string, FakeScript>();
  const parent = {
    insertBefore(node: FakeScript, _ref: FakeScript | null) {
      scripts.unshift(node);
      if (node.id) byId.set(node.id, node);
      return node;
    },
  };
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (_tag: string): FakeScript => ({
      id: "",
      async: false,
      src: "",
      parentNode: null,
    }),
    getElementsByTagName: (_tag: string) => (scripts[0] ? [scripts[0]] : ([] as FakeScript[])),
    head: { appendChild: (node: FakeScript) => scripts.unshift(node) },
  };
  const win: { twq?: TwqLike } = {};
  const seed: FakeScript = { id: "seed", async: false, src: "", parentNode: parent };
  scripts.push(seed);
  return { scripts, doc, win };
}

interface FakeScript {
  id: string;
  async: boolean;
  src: string;
  parentNode: { insertBefore(n: FakeScript, r: FakeScript | null): FakeScript } | null;
}
type TwqLike = ((...args: unknown[]) => void) & { queue?: unknown[]; version?: string };

test("initXPixel is a no-op when no pixel id is configured", () => {
  const { scripts, doc, win } = fakeEnv();
  const before = scripts.length;
  assert.equal(
    initXPixel(undefined, { doc: doc as unknown as Document, win: win as unknown as Window }),
    false,
  );
  assert.equal(
    initXPixel("", { doc: doc as unknown as Document, win: win as unknown as Window }),
    false,
  );
  assert.equal(scripts.length, before);
  assert.equal(win.twq, undefined);
});

test("initXPixel installs the twq shim, injects uwt.js, and configures the pixel once", () => {
  const { scripts, doc, win } = fakeEnv();

  assert.equal(
    initXPixel("re19o", { doc: doc as unknown as Document, win: win as unknown as Window }),
    true,
  );

  assert.equal(typeof win.twq, "function");
  assert.equal(win.twq?.version, "1.1");
  assert.deepEqual(win.twq?.queue?.[0], ["config", "re19o"]);

  const loader = scripts.find((s) => s.id === "x-pixel-loader");
  assert.ok(loader);
  assert.equal(loader?.src, "https://static.ads-twitter.com/uwt.js");
  assert.equal(loader?.async, true);

  // Re-running (e.g. HMR) must not inject a second loader or re-config.
  const queuedBefore = win.twq?.queue?.length;
  assert.equal(
    initXPixel("re19o", { doc: doc as unknown as Document, win: win as unknown as Window }),
    false,
  );
  assert.equal(scripts.filter((s) => s.id === "x-pixel-loader").length, 1);
  assert.equal(win.twq?.queue?.length, queuedBefore);
});
