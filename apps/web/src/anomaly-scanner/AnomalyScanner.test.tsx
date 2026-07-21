import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ProjectRouteProvider } from "../ProjectRouteContext.tsx";
import { AnomalyScannerView } from "./AnomalyScanner.tsx";

test("scan history shows coverage, findings, and linked incidents", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ProjectRouteProvider slugs={{ orgSlug: "acme", projectSlug: "default" }}>
        <AnomalyScannerView
          activeTab="history"
          onTabChange={() => {}}
          saving={false}
          onSave={() => {}}
          data={{
            settings: {
              enabled: true,
              cadenceHours: 6,
              observationMinutes: 60,
              baselineHours: 24,
            },
            scans: [
              {
                id: "scan-1",
                status: "completed",
                metricSeriesScanned: 42,
                findingsCount: 1,
                incidentsOpened: 1,
                incidentsDeduped: 0,
                audit: null,
                error: null,
                startedAt: "2026-07-14T12:00:00.000Z",
                completedAt: "2026-07-14T12:03:00.000Z",
                findings: [
                  {
                    title: "Checkout latency jumped",
                    metricName: "http.server.duration",
                    service: "checkout-api",
                    direction: "spike",
                    issueId: "issue-1",
                    incidentId: "incident-1",
                  },
                ],
              },
            ],
          }}
        />
      </ProjectRouteProvider>
    </MemoryRouter>,
  );

  assert.match(html, /Anomaly scanner/);
  assert.match(html, /42 metric series/);
  assert.match(html, /Checkout latency jumped/);
  assert.match(html, /href="\/app\/org\/acme\/project\/default\/anomaly-scanner\/scans\/scan-1"/);
  assert.match(html, /href="\/app\/org\/acme\/project\/default\/incidents\/incident-1"/);
});

test("configuration exposes project scan controls", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <AnomalyScannerView
        activeTab="configuration"
        onTabChange={() => {}}
        saving={false}
        onSave={() => {}}
        data={{
          settings: {
            enabled: true,
            cadenceHours: 6,
            observationMinutes: 60,
            baselineHours: 24,
          },
          scans: [],
        }}
      />
    </MemoryRouter>,
  );

  assert.match(html, /Scan configuration/);
  assert.match(html, /role="switch" aria-checked="true"/);
  assert.match(html, /aria-label="Scan cadence"/);
  assert.match(html, /Every 6 hours/);
  assert.match(html, /aria-label="Observation window"/);
  assert.match(html, /aria-label="Baseline window"/);
});
