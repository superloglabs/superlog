import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ProjectRouteProvider } from "../ProjectRouteContext.tsx";
import { ProductShell } from "./ProductShell.tsx";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./sidebarCollapsed.ts";

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

test("the shell renders a collapse toggle and expanded nav labels by default", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <ProductShell>
        <main>Page body</main>
      </ProductShell>
    </MemoryRouter>,
  );

  // Server render has no localStorage, so the sidebar defaults to expanded.
  assert.match(html, /aria-label="Collapse sidebar"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, />Overview<\/span>/);
});

test("primary navigation emits canonical project URLs", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/org/superlog/project/demo-project/explore/logs"]}>
      <ProjectRouteProvider slugs={{ orgSlug: "superlog", projectSlug: "demo-project" }}>
        <ProductShell>
          <main>Explore page</main>
        </ProductShell>
      </ProjectRouteProvider>
    </MemoryRouter>,
  );

  assert.match(html, /href="\/org\/superlog\/project\/demo-project"/);
  for (const appPath of ["incidents", "issues", "alerts", "explore", "dashboards", "settings"]) {
    assert.match(html, new RegExp(`href="/org/superlog/project/demo-project/${appPath}"`));
  }
});

test("sidebar collapse state round-trips through localStorage", () => {
  const store = new Map<string, string>();
  const original = globalThis.window;
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  globalThis.window = { localStorage } as unknown as Window & typeof globalThis;
  try {
    assert.equal(readSidebarCollapsed(), false);
    writeSidebarCollapsed(true);
    assert.equal(readSidebarCollapsed(), true);
    writeSidebarCollapsed(false);
    assert.equal(readSidebarCollapsed(), false);
  } finally {
    globalThis.window = original;
  }
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

test("anomaly scanner navigation is visible only for flagged organizations", () => {
  const disabled = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <ProductShell>
        <main>Overview</main>
      </ProductShell>
    </MemoryRouter>,
  );
  const enabled = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/anomaly-scanner"]}>
      <ProductShell anomalyScannerEnabled>
        <main>Scanner</main>
      </ProductShell>
    </MemoryRouter>,
  );

  assert.doesNotMatch(disabled, /href="\/anomaly-scanner"/);
  assert.match(enabled, /aria-current="page"[^>]*href="\/anomaly-scanner"/);
  assert.match(enabled, />Anomaly scanner<\/span>/);
});

test("the command palette mirrors the incidents and errors navigation", async () => {
  const source = await readFile(new URL("../CommandPalette.tsx", import.meta.url), "utf8");

  assert.match(source, /label: "Incidents"[\s\S]*?navigate\(projectPath\("\/incidents"\)\)/);
  assert.match(source, /label: "Errors"[\s\S]*?navigate\(projectPath\("\/issues"\)\)/);
  assert.doesNotMatch(source, /label: "Issues"/);
});

test("incident and error pages do not repeat primary navigation as horizontal tabs", async () => {
  const source = await readFile(new URL("../Issues.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\(\["incidents", "issues"\] as const\)\.map/);
});
