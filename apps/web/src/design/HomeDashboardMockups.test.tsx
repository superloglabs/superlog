import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeDashboardMockups } from "./HomeDashboardMockups.tsx";

test("the home dashboard studio offers five distinct directions to compare", () => {
  const html = renderToStaticMarkup(<HomeDashboardMockups />);

  assert.match(html, /Command center/);
  assert.match(html, /Dashboard rail/);
  assert.match(html, /Signal stack/);
  assert.match(html, /Pulse deck/);
  assert.match(html, /Daily briefing/);
  assert.equal((html.match(/data-dashboard-concept=/g) ?? []).length, 5);
});
