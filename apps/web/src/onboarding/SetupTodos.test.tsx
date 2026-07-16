import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupSignalsSettled } from "./SetupTodos.tsx";
import { SetupTodosView } from "./SetupTodosView.tsx";

test("setup remains visible after a status request fails", () => {
  assert.equal(
    setupSignalsSettled([
      { data: { installed: false }, error: null },
      { data: undefined, error: new Error("stats unavailable") },
      { data: { connected: false }, error: null },
    ]),
    true,
  );
});

test("demo exploration replaces the setup carousel with the demo banner", () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;

  const html = renderToStaticMarkup(
    <SetupTodosView showDemoExploringBanner stopExploring={() => {}} />,
  );

  assert.match(html, /You(?:'|&#x27;)re exploring sample data/);
  assert.match(html, /Connect your app/);
  assert.doesNotMatch(html, /Finish setting up Superlog/);
});
