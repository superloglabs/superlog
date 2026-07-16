import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeCustomizePanel } from "./HomeCustomizePanel.tsx";

test("home customization exposes every built-in plus widget and link actions", () => {
  const html = renderToStaticMarkup(
    <HomeCustomizePanel
      enabledBuiltins={["setup_todos", "active_incidents", "service_map"]}
      onToggleBuiltin={() => {}}
      onAddWidget={() => {}}
      onAddLink={() => {}}
      onDone={() => {}}
    />,
  );

  assert.match(html, /Setup checklist/);
  assert.match(html, /Active incidents/);
  assert.match(html, /Service map/);
  assert.match(html, /Add data widget/);
  assert.match(html, /Add link/);
});
