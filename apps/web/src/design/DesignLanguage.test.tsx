import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DesignLanguage } from "./DesignLanguage.tsx";

test("the design catalog presents the quiet operational interface language", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <DesignLanguage />
    </MemoryRouter>,
  );

  assert.match(html, /A quiet interface.*for noisy systems/s);
  assert.match(html, /Dense data, clear hierarchy/);
  assert.match(html, /Operational palette/);
  assert.match(html, /<aside/);
  assert.doesNotMatch(html, /font-mono/);

  const sidebar = html.match(/<aside.*?<\/aside>/s)?.[0] ?? "";
  assert.doesNotMatch(sidebar, />0[1-9]</);
});

test("the dark operational surfaces use the deeper palette without changing light mode", async () => {
  const css = await readFile(new URL("../index.css", import.meta.url), "utf8");

  assert.match(css, /--color-bg-rgb:\s*18 18 18/);
  assert.match(css, /--color-surface-rgb:\s*23 23 23/);
  assert.match(css, /--color-surface-2-rgb:\s*28 28 28/);
  assert.match(css, /--color-surface-3-rgb:\s*35 35 35/);
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--color-bg-rgb:\s*245 245 245/);
});
