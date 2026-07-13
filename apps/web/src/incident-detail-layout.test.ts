import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IncidentDetailScrollArea } from "./incidents/IncidentDetailScrollArea.tsx";

test("incident detail content scrolls vertically without exposing a horizontal scrollbar", () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const html = renderToStaticMarkup(
    createElement(IncidentDetailScrollArea, null, "Incident activity"),
  );

  assert.match(html, /overflow-x-hidden overflow-y-auto/);
});
