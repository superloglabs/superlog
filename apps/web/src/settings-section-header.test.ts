import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSectionHeader } from "./settings/rows.tsx";

test("settings groups use the same title and subtitle hierarchy as top-level settings sections", () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const html = renderToStaticMarkup(
    createElement(SettingsSectionHeader, {
      title: "Weekly recap",
      subtitle: "A weekly Slack recap for this project.",
    }),
  );

  assert.match(html, /<h2[^>]*>Weekly recap<\/h2>/);
  assert.match(html, /<p[^>]*>A weekly Slack recap for this project\.<\/p>/);
});
