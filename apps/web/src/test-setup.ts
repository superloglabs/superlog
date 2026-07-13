// Preloaded before the web unit tests (see the package's `test` script:
// `tsx --import ./src/test-setup.ts --test ...`).
//
// The web tests run under `node --test`, which has no DOM. Some browser
// libraries we import from pure model modules — notably `@pierre/diffs`, pulled
// in by `incident-pr-diff-model.ts` — read `navigator.userAgent` at module-eval
// time. Node ≥21 exposes a `navigator` global so that works locally, but on
// runtimes without it (older Node, as on CI) `navigator` is `undefined` and the
// import throws before any test runs. Define a minimal stand-in so those imports
// evaluate. Only fills the gap when the global is actually missing.
if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node" },
    configurable: true,
    writable: true,
  });
}
