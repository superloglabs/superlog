import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { EvidenceMarkdown } from "./EvidenceMarkdown.tsx";
import { ProjectRouteProvider } from "./ProjectRouteContext.tsx";

test("trace references link to the canonical project route", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ProjectRouteProvider slugs={{ orgSlug: "acme", projectSlug: "default" }}>
        <EvidenceMarkdown text="Trace 0123456789abcdef0123456789abcdef" ctx={{}} />
      </ProjectRouteProvider>
    </MemoryRouter>,
  );

  assert.match(
    html,
    /href="\/app\/org\/acme\/project\/default\/explore\/traces\?trace=0123456789abcdef0123456789abcdef"/,
  );
});
