import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ProjectRouteProvider } from "../ProjectRouteContext.tsx";
import { AnomalyScanDetailView } from "./AnomalyScanDetail.tsx";

test("scan detail explains telemetry evidence, code grounding, and incident outcome", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ProjectRouteProvider slugs={{ orgSlug: "acme", projectSlug: "default" }}>
        <AnomalyScanDetailView
          scan={{
            id: "scan-1",
            status: "completed",
            metricSeriesScanned: 42,
            findingsCount: 1,
            incidentsOpened: 0,
            incidentsDeduped: 1,
            audit: null,
            error: null,
            startedAt: "2026-07-14T12:00:00.000Z",
            completedAt: "2026-07-14T12:03:00.000Z",
            findings: [
              {
                title: "Checkout latency jumped",
                summary: "Latency remained elevated across the full observation window.",
                metricName: "http.server.duration",
                service: "checkout-api",
                direction: "spike",
                dimensions: { route: "/checkout" },
                observedValue: 820,
                baselineValue: 240,
                observedSince: "2026-07-14T11:00:00.000Z",
                observedUntil: "2026-07-14T12:00:00.000Z",
                evidence: "p95 was 3.4× its preceding baseline.",
                codeEvidence: [
                  {
                    repository: "superloglabs/store",
                    path: "src/checkout.ts",
                    line: 84,
                    quote: "await inventory.reserve(items)",
                    explanation: "The reservation call is serialized on the request path.",
                  },
                ],
                incidentOutcome: "deduped",
                issueId: "issue-1",
                incidentId: "incident-1",
              },
            ],
          }}
        />
      </ProjectRouteProvider>
    </MemoryRouter>,
  );

  assert.match(html, /Scan detail/);
  assert.match(html, /820/);
  assert.match(html, /240/);
  assert.match(html, /p95 was 3.4× its preceding baseline/);
  assert.match(html, /superloglabs\/store/);
  assert.match(html, /src\/checkout.ts:84/);
  assert.match(html, /await inventory.reserve\(items\)/);
  assert.match(html, /href="\/app\/org\/acme\/project\/default\/incidents\/incident-1"/);
  assert.match(html, /Joined existing incident/);
});

test("scan coverage renders every metric and comparison source checked", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <AnomalyScanDetailView
        activeTab="coverage"
        onTabChange={() => {}}
        scan={{
          id: "scan-coverage",
          status: "completed",
          metricSeriesScanned: 2,
          findingsCount: 0,
          incidentsOpened: 0,
          incidentsDeduped: 0,
          findings: [],
          error: null,
          startedAt: "2026-07-14T12:00:00.000Z",
          completedAt: "2026-07-14T12:03:00.000Z",
          audit: {
            version: 1,
            baselineSince: "2026-07-13T11:00:00.000Z",
            observedSince: "2026-07-14T11:00:00.000Z",
            observedUntil: "2026-07-14T12:00:00.000Z",
            metrics: [
              {
                kind: "gauge",
                metricName: "queue.depth",
                service: "worker",
                observedCount: 120,
                observedAverage: 12,
                observedMin: 2,
                observedMax: 48,
                baselineCount: 2_880,
                baselineAverage: 9,
                baselineMin: 1,
                baselineMax: 30,
              },
              {
                kind: "sum",
                metricName: "jobs.completed",
                service: "worker",
                observedCount: 120,
                observedAverage: 420,
                observedMin: 380,
                observedMax: 490,
                baselineCount: 2_880,
                baselineAverage: 410,
                baselineMin: 350,
                baselineMax: 500,
              },
            ],
            repositories: ["acme/worker"],
            alertsCompared: [{ id: "alert-1", name: "Queue backlog", metricName: "queue.depth" }],
            incidentsCompared: [{ id: "incident-1", title: "Delayed jobs", service: "worker" }],
            decisions: [],
          },
        }}
      />
    </MemoryRouter>,
  );

  assert.match(html, /Everything checked/);
  assert.match(html, /queue.depth/);
  assert.match(html, /jobs.completed/);
  assert.match(html, /acme\/worker/);
  assert.match(html, /Queue backlog/);
  assert.match(html, /Delayed jobs/);
});

test("decision log renders concise accepted and rejected candidate rationales", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <AnomalyScanDetailView
        activeTab="decisions"
        onTabChange={() => {}}
        scan={{
          id: "scan-decisions",
          status: "completed",
          metricSeriesScanned: 2,
          findingsCount: 1,
          incidentsOpened: 1,
          incidentsDeduped: 0,
          findings: [],
          error: null,
          startedAt: "2026-07-14T12:00:00.000Z",
          completedAt: "2026-07-14T12:03:00.000Z",
          audit: {
            version: 1,
            baselineSince: "2026-07-13T11:00:00.000Z",
            observedSince: "2026-07-14T11:00:00.000Z",
            observedUntil: "2026-07-14T12:00:00.000Z",
            metrics: [],
            repositories: ["acme/worker"],
            alertsCompared: [],
            incidentsCompared: [],
            decisions: [
              {
                metricName: "queue.depth",
                service: "worker",
                verdict: "rejected",
                reasonCode: "transient_outlier",
                rationale: "One high bucket recovered within five minutes.",
                codePaths: [{ repository: "acme/worker", path: "src/queue.ts", line: 42 }],
              },
              {
                metricName: "http.server.duration",
                service: "api",
                verdict: "finding",
                reasonCode: "finding",
                rationale: "The sustained shift was grounded in the checkout request path.",
                codePaths: [{ repository: "acme/api", path: "src/checkout.ts", line: 84 }],
              },
            ],
          },
        }}
      />
    </MemoryRouter>,
  );

  assert.match(html, /Concise audit notes/);
  assert.match(html, /Transient outlier/);
  assert.match(html, /One high bucket recovered within five minutes/);
  assert.match(html, /Accepted finding/);
  assert.match(html, /acme\/worker · src\/queue.ts:42/);
  assert.doesNotMatch(html, /thought process/i);
});
