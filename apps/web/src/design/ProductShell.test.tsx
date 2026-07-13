import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ProductShell } from "./ProductShell.tsx";

test("the signed-in shell uses standard icons without workspace status copy", async () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/explore/logs"]}>
      <ProductShell toolbar={<button type="button">Project controls</button>}>
        <main>Page body</main>
      </ProductShell>
    </MemoryRouter>,
  );

  assert.match(html, /<aside/);
  assert.match(html, /aria-current="page"[^>]*href="\/explore"/);
  assert.match(html, /Project controls/);
  assert.match(html, /Page body/);
  assert.doesNotMatch(html, /font-mono/);
  assert.doesNotMatch(html, /Operational workspace/);

  const source = await readFile(new URL("./ProductShell.tsx", import.meta.url), "utf8");
  assert.match(source, /@phosphor-icons\/react/);
  assert.doesNotMatch(source, /function NavigationIcon/);
});

test("errors and incidents are separate primary navigation destinations", () => {
  const issuesHtml = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/issues"]}>
      <ProductShell>
        <main>Issues page</main>
      </ProductShell>
    </MemoryRouter>,
  );
  const incidentsHtml = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/incidents"]}>
      <ProductShell>
        <main>Incidents page</main>
      </ProductShell>
    </MemoryRouter>,
  );

  assert.match(issuesHtml, /aria-current="page"[^>]*href="\/issues"/);
  assert.doesNotMatch(issuesHtml, /aria-current="page"[^>]*href="\/incidents"/);
  assert.match(incidentsHtml, /aria-current="page"[^>]*href="\/incidents"/);
  assert.doesNotMatch(incidentsHtml, /aria-current="page"[^>]*href="\/issues"/);
  assert.match(issuesHtml, />Errors<\/span>/);
  assert.doesNotMatch(issuesHtml, />Issues<\/span>/);
  assert.match(incidentsHtml, />Incidents<\/span>/);

  const incidentsPosition = issuesHtml.indexOf(">Incidents</span>");
  const errorsPosition = issuesHtml.indexOf(">Errors</span>");
  assert.ok(incidentsPosition >= 0 && errorsPosition >= 0);
  assert.ok(incidentsPosition < errorsPosition, "Incidents should appear above Errors");
});

test("the command palette mirrors the incidents and errors navigation", async () => {
  const source = await readFile(new URL("../CommandPalette.tsx", import.meta.url), "utf8");

  assert.match(source, /label: "Incidents"[^\n]*navigate\("\/incidents"\)/);
  assert.match(source, /label: "Errors"[^\n]*navigate\("\/issues"\)/);
  assert.doesNotMatch(source, /label: "Issues"/);
});

test("incident and error pages do not repeat primary navigation as horizontal tabs", async () => {
  const source = await readFile(new URL("../Issues.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\(\["incidents", "issues"\] as const\)\.map/);
});
