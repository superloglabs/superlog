import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type AnomalyScan,
  type AnomalyScanAudit,
  type AnomalyScanFinding,
  useAnomalyScan,
  useMe,
} from "../api.ts";
import { Chip, PageHeader, Tabs } from "../design/ui.tsx";

type ScanDetailTab = "findings" | "coverage" | "decisions";

export function AnomalyScanDetail() {
  const { scanId } = useParams<{ scanId: string }>();
  const me = useMe();
  const featureEnabled = me.data?.features?.anomalyScanner === true;
  const scan = useAnomalyScan(me.data?.project?.id, scanId, featureEnabled);
  const [activeTab, setActiveTab] = useState<ScanDetailTab>("findings");

  if (!featureEnabled) return null;
  if (scan.error) {
    return <div className="px-1 py-10 text-[12px] text-danger">Unable to load this scan.</div>;
  }
  if (scan.isLoading || !scan.data) {
    return <div className="px-1 py-10 text-[12px] text-muted">Loading scan detail…</div>;
  }
  return (
    <AnomalyScanDetailView scan={scan.data} activeTab={activeTab} onTabChange={setActiveTab} />
  );
}

export function AnomalyScanDetailView({
  scan,
  activeTab = "findings",
  onTabChange = () => {},
}: {
  scan: AnomalyScan;
  activeTab?: ScanDetailTab;
  onTabChange?: (tab: ScanDetailTab) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/anomaly-scanner"
        className="inline-flex w-fit items-center gap-1.5 text-[11px] font-medium text-muted hover:text-fg"
      >
        <ArrowLeftIcon size={13} aria-hidden />
        Scan history
      </Link>
      <PageHeader
        title="Scan detail"
        description={`Started ${formatDate(scan.startedAt)} · ${duration(scan.startedAt, scan.completedAt)}`}
        actions={<Chip tone={statusTone(scan.status)}>{statusLabel(scan.status)}</Chip>}
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Metric series" value={scan.metricSeriesScanned} />
        <Stat label="Findings" value={scan.findingsCount} />
        <Stat label="Incidents opened" value={scan.incidentsOpened} />
        <Stat label="Deduplicated" value={scan.incidentsDeduped} />
      </div>

      {scan.error && (
        <div className="rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-[12px] text-danger">
          {scan.error}
        </div>
      )}

      <Tabs
        value={activeTab}
        onChange={onTabChange}
        options={[
          { value: "findings", label: `Findings (${scan.findings.length})` },
          { value: "coverage", label: `Coverage (${scan.audit?.metrics.length ?? 0})` },
          { value: "decisions", label: `Decision log (${scan.audit?.decisions.length ?? 0})` },
        ]}
      />

      {activeTab === "findings" && <FindingsPanel scan={scan} />}
      {activeTab === "coverage" && <CoveragePanel audit={scan.audit} />}
      {activeTab === "decisions" && <DecisionLogPanel audit={scan.audit} />}
    </div>
  );
}

function FindingsPanel({ scan }: { scan: AnomalyScan }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[13px] font-medium text-fg">Findings</h2>
        <p className="mt-1 text-[11px] text-muted">
          Metric evidence and the code paths used to ground each anomaly.
        </p>
      </div>
      {scan.findings.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface px-5 py-14 text-center">
          <PulseIcon size={24} className="mx-auto text-subtle" aria-hidden />
          <p className="mt-3 text-[13px] font-medium text-fg">No anomalies found</p>
          <p className="mt-1 text-[11px] text-muted">
            Nothing crossed the scanner’s evidence threshold in this run.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {scan.findings.map((finding) => (
            <FindingDetail key={`${finding.issueId}:${finding.metricName}`} finding={finding} />
          ))}
        </div>
      )}
    </section>
  );
}

function CoveragePanel({ audit }: { audit: AnomalyScanAudit | null }) {
  if (!audit) return <AuditUnavailable />;
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-[13px] font-medium text-fg">Everything checked</h2>
        <p className="mt-1 text-[11px] text-muted">
          Exact server-recorded inputs supplied to this scan—not generated reasoning.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <WindowCard label="Baseline window" start={audit.baselineSince} end={audit.observedSince} />
        <WindowCard
          label="Observation window"
          start={audit.observedSince}
          end={audit.observedUntil}
        />
      </div>

      <AuditSection title={`Metric catalog · ${audit.metrics.length}`}>
        {audit.metrics.length === 0 ? (
          <EmptyAuditValue>No metric series were supplied.</EmptyAuditValue>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead className="border-b border-border bg-surface-2/50 text-[10px] uppercase tracking-wide text-subtle">
                <tr>
                  <th className="px-4 py-2 font-medium">Metric</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 font-medium">Observed</th>
                  <th className="px-4 py-2 font-medium">Baseline</th>
                  <th className="px-4 py-2 font-medium">Samples</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {audit.metrics.map((metric) => (
                  <tr key={`${metric.kind}:${metric.metricName}:${metric.service}`}>
                    <td className="px-4 py-3">
                      <div className="font-mono text-[11px] text-fg">{metric.metricName}</div>
                      <div className="mt-0.5 text-[10px] text-subtle">
                        {metric.service || "No service"}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-muted">{metric.kind}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-fg">
                      {formatOptionalValue(metric.observedAverage)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-fg">
                      {formatOptionalValue(metric.baselineAverage)}
                    </td>
                    <td className="px-4 py-3 text-[11px] tabular-nums text-muted">
                      {metric.observedCount.toLocaleString()} /{" "}
                      {metric.baselineCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AuditSection>

      <div className="grid gap-4 lg:grid-cols-3">
        <AuditList title="Repositories inspected" values={audit.repositories} />
        <AuditList
          title="Alerts compared"
          values={audit.alertsCompared.map((alert) =>
            alert.metricName ? `${alert.name} · ${alert.metricName}` : alert.name,
          )}
        />
        <AuditList
          title="Open incidents compared"
          values={audit.incidentsCompared.map((incident) =>
            incident.service ? `${incident.title} · ${incident.service}` : incident.title,
          )}
        />
      </div>
    </section>
  );
}

function DecisionLogPanel({ audit }: { audit: AnomalyScanAudit | null }) {
  if (!audit) return <AuditUnavailable />;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[13px] font-medium text-fg">Concise audit notes</h2>
        <p className="mt-1 text-[11px] text-muted">
          Observable reasons recorded for candidates investigated beyond the full metric catalog.
        </p>
      </div>
      {audit.decisions.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface px-5 py-10 text-center">
          <p className="text-[12px] font-medium text-fg">No candidates required deeper review</p>
          <p className="mt-1 text-[11px] text-muted">
            The coverage tab still contains every metric supplied to the scan.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {audit.decisions.map((decision, index) => (
            <article
              key={`${decision.metricName}:${decision.service}:${index}`}
              className="rounded-xl border border-border bg-surface px-5 py-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={decision.verdict === "finding" ? "danger" : "muted"}>
                      {decision.verdict === "finding" ? "Accepted finding" : "Rejected candidate"}
                    </Chip>
                    <Chip tone="accent">{decisionReasonLabel(decision.reasonCode)}</Chip>
                  </div>
                  <div className="mt-3 font-mono text-[11px] text-fg">
                    {decision.metricName}
                    {decision.service ? ` · ${decision.service}` : ""}
                  </div>
                  <p className="mt-2 text-[12px] leading-5 text-muted">{decision.rationale}</p>
                </div>
              </div>
              {decision.codePaths.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
                  {decision.codePaths.map((path) => (
                    <code
                      key={`${path.repository}:${path.path}:${path.line}`}
                      className="rounded bg-surface-2 px-2 py-1 text-[10px] text-subtle"
                    >
                      {path.repository} · {path.path}
                      {path.line ? `:${path.line}` : ""}
                    </code>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function decisionReasonLabel(reason: AnomalyScanAudit["decisions"][number]["reasonCode"]) {
  const labels: Record<typeof reason, string> = {
    finding: "Finding",
    known_alert: "Known alert",
    open_incident: "Open incident",
    sparse_data: "Sparse data",
    counter_behavior: "Counter behavior",
    transient_outlier: "Transient outlier",
    normal_variation: "Normal variation",
    no_material_impact: "No material impact",
    not_code_grounded: "Not code-grounded",
    other: "Other",
  };
  return labels[reason];
}

function AuditSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-3 text-[12px] font-medium text-fg">
        {title}
      </div>
      {children}
    </section>
  );
}

function AuditList({ title, values }: { title: string; values: string[] }) {
  return (
    <AuditSection title={`${title} · ${values.length}`}>
      {values.length === 0 ? (
        <EmptyAuditValue>None.</EmptyAuditValue>
      ) : (
        <ul className="divide-y divide-border">
          {values.map((value) => (
            <li key={value} className="px-4 py-3 text-[11px] text-muted">
              {value}
            </li>
          ))}
        </ul>
      )}
    </AuditSection>
  );
}

function EmptyAuditValue({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-5 text-[11px] text-muted">{children}</div>;
}

function AuditUnavailable() {
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-10 text-center">
      <p className="text-[12px] font-medium text-fg">Scan audit unavailable</p>
      <p className="mt-1 text-[11px] text-muted">
        This scan was recorded before structured audit capture was enabled.
      </p>
    </div>
  );
}

function WindowCard({ label, start, end }: { label: string; start: string; end: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-4">
      <div className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-2 text-[11px] text-fg">{formatDate(start)}</div>
      <div className="mt-0.5 text-[10px] text-muted">to {formatDate(end)}</div>
    </div>
  );
}

function FindingDetail({ finding }: { finding: AnomalyScanFinding }) {
  const observedValue = finding.observedValue;
  const baselineValue = finding.baselineValue;
  const hasDetailedEvidence =
    observedValue !== undefined && baselineValue !== undefined && finding.evidence !== undefined;
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="accent">{finding.direction}</Chip>
              {finding.incidentOutcome && (
                <Chip tone={finding.incidentOutcome === "opened" ? "danger" : "muted"}>
                  {finding.incidentOutcome === "opened"
                    ? "Opened new incident"
                    : "Joined existing incident"}
                </Chip>
              )}
            </div>
            <h3 className="mt-3 text-[15px] font-semibold text-fg">{finding.title}</h3>
            <p className="mt-1 font-mono text-[10px] text-subtle">
              {finding.metricName}
              {finding.service ? ` · ${finding.service}` : ""}
            </p>
          </div>
          {finding.incidentId && (
            <Link
              to={`/incidents/${finding.incidentId}`}
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-accent hover:underline"
            >
              View incident
              <ArrowSquareOutIcon size={12} aria-hidden />
            </Link>
          )}
        </div>
      </div>

      {hasDetailedEvidence ? (
        <div className="space-y-5 px-5 py-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <ValueCard label="Observed" value={observedValue} />
            <ValueCard label="Baseline" value={baselineValue} />
          </div>
          {finding.summary && <p className="text-[12px] leading-5 text-fg">{finding.summary}</p>}
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-subtle">
              Telemetry evidence
            </div>
            <p className="mt-2 text-[12px] leading-5 text-muted">{finding.evidence}</p>
            {finding.observedSince && finding.observedUntil && (
              <p className="mt-2 text-[10px] text-subtle">
                Observation window: {formatDate(finding.observedSince)} –{" "}
                {formatDate(finding.observedUntil)}
              </p>
            )}
          </div>
          {finding.dimensions && Object.keys(finding.dimensions).length > 0 && (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-subtle">
                Series dimensions
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(finding.dimensions).map(([key, value]) => (
                  <code key={key} className="rounded bg-surface-2 px-2 py-1 text-[10px] text-muted">
                    {key}={value}
                  </code>
                ))}
              </div>
            </div>
          )}
          {finding.codeEvidence && finding.codeEvidence.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-subtle">
                <CodeIcon size={13} aria-hidden />
                Code evidence
              </div>
              <div className="mt-2 space-y-2">
                {finding.codeEvidence.map((evidence) => (
                  <div
                    key={`${evidence.repository}:${evidence.path}:${evidence.line}`}
                    className="rounded-lg border border-border bg-surface-2/50 px-4 py-3"
                  >
                    <div className="font-mono text-[10px] text-subtle">
                      {evidence.repository} · {evidence.path}:{evidence.line}
                    </div>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-surface-3 px-3 py-2 font-mono text-[11px] text-fg">
                      {evidence.quote}
                    </pre>
                    <p className="mt-2 text-[11px] leading-5 text-muted">{evidence.explanation}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="px-5 py-5 text-[11px] text-muted">
          Detailed evidence was not retained for this earlier scan.
        </div>
      )}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-4">
      <div className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-2 text-[20px] font-semibold tracking-tight text-fg">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function ValueCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 px-4 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 font-mono text-[15px] font-medium text-fg">{formatValue(value)}</div>
    </div>
  );
}

function statusTone(status: AnomalyScan["status"]) {
  return status === "completed" ? "success" : status === "failed" ? "danger" : "accent";
}

function statusLabel(status: AnomalyScan["status"]) {
  return status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Running";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function duration(startedAt: string, completedAt: string | null) {
  if (!completedAt) return "In progress";
  const seconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatValue(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

function formatOptionalValue(value: number | null) {
  return value === null ? "—" : formatValue(value);
}
