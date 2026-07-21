import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { IncidentAlertEpisode } from "../api.ts";
import { ProjectRouteProvider } from "../ProjectRouteContext.tsx";
import { TriggeredByAlertMetaRow } from "./TriggeredByAlertMetaRow.tsx";

function episode(overrides: Partial<IncidentAlertEpisode> = {}): IncidentAlertEpisode {
  return {
    id: "ep-1",
    alertId: "alert-1",
    alertName: "p95 latency > 500ms",
    groupKey: "",
    state: "firing",
    startedAt: "2026-07-14T10:00:00.000Z",
    endedAt: null,
    peakObservedValue: 812,
    seq: 1,
    issueId: null,
    ...overrides,
  };
}

function render(episodes: IncidentAlertEpisode[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ProjectRouteProvider slugs={{ orgSlug: "acme", projectSlug: "default" }}>
        <TriggeredByAlertMetaRow episodes={episodes} />
      </ProjectRouteProvider>
    </MemoryRouter>,
  );
}

test("links the alert that fired straight to the alert page", () => {
  const html = render([episode()]);
  assert.match(html, /Triggered by/);
  assert.match(html, /p95 latency &gt; 500ms/);
  assert.match(html, /href="\/app\/org\/acme\/project\/default\/alerts\/alert-1"/);
});

test("renders nothing when there are no alert episodes", () => {
  assert.equal(render([]), "");
});

test("collapses multiple episodes of the same alert to a single link", () => {
  const html = render([
    episode({ id: "ep-1", seq: 1 }),
    episode({ id: "ep-2", seq: 2, state: "resolved" }),
  ]);
  const links = html.match(/href="\/app\/org\/acme\/project\/default\/alerts\/alert-1"/g) ?? [];
  assert.equal(links.length, 1);
});

test("lists each distinct alert when an incident groups more than one", () => {
  const html = render([
    episode({ id: "ep-1", alertId: "alert-1", alertName: "latency" }),
    episode({ id: "ep-2", alertId: "alert-2", alertName: "error rate" }),
  ]);
  assert.match(html, /href="\/app\/org\/acme\/project\/default\/alerts\/alert-1"/);
  assert.match(html, /href="\/app\/org\/acme\/project\/default\/alerts\/alert-2"/);
  assert.match(html, /latency/);
  assert.match(html, /error rate/);
});
