import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { McpAuthenticationEditor } from "./AgentMcpServersCard.tsx";
import { EMPTY_AUTH } from "./project-mcp-editor.ts";

test("automatic MCP auth does not show the manual authentication dropdown by default", () => {
  const html = renderToStaticMarkup(
    <McpAuthenticationEditor
      manual={false}
      detectionMessage={null}
      value={EMPTY_AUTH}
      onChange={() => {}}
      onConfigureManually={() => {}}
      onUseAutomatic={() => {}}
    />,
  );

  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /Bearer \/ API token/);
  assert.doesNotMatch(html, /Authentication is detected automatically/);
  assert.doesNotMatch(html, /Configure authentication manually/);
  assert.match(html, /Set auth manually/);
});

test("manual MCP auth reveals credential choices only after the fallback is requested", () => {
  const html = renderToStaticMarkup(
    <McpAuthenticationEditor
      manual
      detectionMessage="No standard OAuth metadata detected."
      value={EMPTY_AUTH}
      onChange={() => {}}
      onConfigureManually={() => {}}
      onUseAutomatic={() => {}}
    />,
  );

  assert.match(html, /<select/);
  assert.match(html, /Bearer \/ API token/);
  assert.match(html, /Use auto/);
});
