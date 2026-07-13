import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { shouldShowMcpPill } from "./mcpPill.ts";

test("pill stays hidden until the project + mcp status have loaded", () => {
  assert.equal(
    shouldShowMcpPill({ projectId: undefined, connected: false, dismissed: false }),
    false,
  );
  assert.equal(
    shouldShowMcpPill({ projectId: "p1", connected: undefined, dismissed: false }),
    false,
  );
});

test("pill shows when a project exists and mcp is not connected", () => {
  assert.equal(shouldShowMcpPill({ projectId: "p1", connected: false, dismissed: false }), true);
});

test("pill hides once mcp is connected", () => {
  assert.equal(shouldShowMcpPill({ projectId: "p1", connected: true, dismissed: false }), false);
});

test("pill stays hidden after the user dismisses it", () => {
  assert.equal(shouldShowMcpPill({ projectId: "p1", connected: false, dismissed: true }), false);
});

test("pill is fixed to the bottom-right and opens the install dialog", async () => {
  const source = await readFile(new URL("./McpInstallPill.tsx", import.meta.url), "utf8");
  assert.match(source, /fixed/);
  assert.match(source, /bottom-/);
  assert.match(source, /right-/);
  assert.doesNotMatch(source, /bottom-5 left-5/);
  assert.match(source, /McpInstallDialog/);
  assert.match(source, /useMcpStatus/);
});

test("pill is mounted in the authenticated app shell", async () => {
  const source = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(source, /<McpInstallPill \/>/);
});
