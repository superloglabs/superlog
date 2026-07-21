import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type AnomalyScannerData,
  type AnomalyScannerSettings,
  useAnomalyScanner,
  useMe,
  useSaveAnomalyScannerSettings,
} from "../api.ts";
import { Btn, Chip, PageHeader, Tabs } from "../design/ui.tsx";
import { useProjectPath } from "../ProjectRouteContext.tsx";

type ScannerTab = "history" | "configuration";

export function AnomalyScanner() {
  const me = useMe();
  const featureEnabled = me.data?.features?.anomalyScanner === true;
  const scanner = useAnomalyScanner(me.data?.project?.id, featureEnabled);
  const save = useSaveAnomalyScannerSettings(me.data?.project?.id);
  const [activeTab, setActiveTab] = useState<ScannerTab>("history");

  if (!featureEnabled) return null;
  if (scanner.error) {
    return <div className="px-1 py-10 text-[12px] text-danger">Unable to load scan history.</div>;
  }
  if (scanner.isLoading || !scanner.data) {
    return <div className="px-1 py-10 text-[12px] text-muted">Loading anomaly scans…</div>;
  }

  return (
    <AnomalyScannerView
      data={scanner.data}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      saving={save.isPending}
      onSave={(settings) => save.mutate(settings)}
    />
  );
}

export function AnomalyScannerView({
  data,
  activeTab,
  onTabChange,
  saving,
  onSave,
}: {
  data: AnomalyScannerData;
  activeTab: ScannerTab;
  onTabChange: (tab: ScannerTab) => void;
  saving: boolean;
  onSave: (settings: AnomalyScannerSettings) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Anomaly scanner"
        description="Continuously compare metric behavior with its baseline, trace suspicious changes into code, and open or join incidents."
        actions={
          <Chip tone={data.settings.enabled ? "success" : "muted"} dot>
            {data.settings.enabled ? "Scanning enabled" : "Scanning paused"}
          </Chip>
        }
      />
      <Tabs
        value={activeTab}
        onChange={onTabChange}
        options={[
          { value: "history", label: "Scan history" },
          { value: "configuration", label: "Configuration" },
        ]}
      />
      {activeTab === "history" ? (
        <HistoryPanel data={data} />
      ) : (
        <ConfigurationPanel settings={data.settings} saving={saving} onSave={onSave} />
      )}
    </div>
  );
}

function HistoryPanel({ data }: { data: AnomalyScannerData }) {
  const projectPath = useProjectPath();
  const latest = data.scans[0];
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard
          label="Last scan"
          value={latest ? relativeDate(latest.startedAt) : "Not run yet"}
          detail={latest ? statusLabel(latest.status) : `Every ${data.settings.cadenceHours} hours`}
        />
        <SummaryCard
          label="Metric coverage"
          value={latest ? latest.metricSeriesScanned.toLocaleString() : "—"}
          detail="series in latest scan"
        />
        <SummaryCard
          label="Incidents opened"
          value={latest ? latest.incidentsOpened.toLocaleString() : "—"}
          detail={latest ? `${latest.incidentsDeduped} deduplicated` : "No scan history"}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-[13px] font-medium text-fg">Recent scans</h2>
          <p className="mt-1 text-[11px] text-muted">The latest 50 runs for this project.</p>
        </div>
        {data.scans.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <PulseIcon size={24} className="mx-auto text-subtle" aria-hidden />
            <p className="mt-3 text-[13px] font-medium text-fg">No scans yet</p>
            <p className="mt-1 text-[11px] text-muted">
              The first run starts on the next scheduled scanner tick.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {data.scans.map((scan) => (
              <article key={scan.id} className="px-5 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <ScanStatusIcon status={scan.status} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-fg">
                          {formatDate(scan.startedAt)}
                        </span>
                        <Chip tone={statusTone(scan.status)}>{statusLabel(scan.status)}</Chip>
                      </div>
                      <p className="mt-1 text-[11px] text-muted">
                        {scan.metricSeriesScanned.toLocaleString()} metric series ·{" "}
                        {scan.findingsCount} {scan.findingsCount === 1 ? "finding" : "findings"} ·{" "}
                        {scan.incidentsOpened} opened · {scan.incidentsDeduped} deduplicated
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-[10px] tabular-nums text-subtle">
                      {duration(scan.startedAt, scan.completedAt)}
                    </span>
                    <Link
                      to={projectPath(`/anomaly-scanner/scans/${scan.id}`)}
                      className="text-[11px] font-medium text-accent hover:underline"
                    >
                      View scan
                    </Link>
                  </div>
                </div>

                {scan.error && (
                  <div className="mt-3 rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-[11px] text-danger">
                    {scan.error}
                  </div>
                )}

                {scan.findings.length > 0 && (
                  <div className="mt-4 space-y-2 border-l border-border pl-4">
                    {scan.findings.map((finding) => (
                      <div
                        key={`${finding.issueId}:${finding.metricName}`}
                        className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[12px] font-medium text-fg">
                            {finding.title}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-subtle">
                            {finding.metricName}
                            {finding.service ? ` · ${finding.service}` : ""} · {finding.direction}
                          </div>
                        </div>
                        {finding.incidentId && (
                          <Link
                            to={projectPath(`/incidents/${finding.incidentId}`)}
                            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-accent hover:underline"
                          >
                            View incident
                            <ArrowSquareOutIcon size={12} aria-hidden />
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ConfigurationPanel({
  settings,
  saving,
  onSave,
}: {
  settings: AnomalyScannerSettings;
  saving: boolean;
  onSave: (settings: AnomalyScannerSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const changed = JSON.stringify(draft) !== JSON.stringify(settings);
  return (
    <section className="max-w-3xl overflow-hidden rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[13px] font-medium text-fg">Scan configuration</h2>
        <p className="mt-1 text-[11px] leading-5 text-muted">
          Configure how often this project is scanned and which periods are compared.
        </p>
      </div>
      <div className="divide-y divide-border">
        <SettingRow
          label="Automatic scans"
          description="Evaluate telemetry and open or join incidents when new anomalies are grounded in code."
        >
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            onClick={() => setDraft((value) => ({ ...value, enabled: !value.enabled }))}
            className={`relative h-6 w-10 rounded-full transition-colors ${
              draft.enabled ? "bg-accent" : "bg-surface-3"
            }`}
          >
            <span
              className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform ${
                draft.enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </SettingRow>
        <SettingRow label="Cadence" description="How often an eligible project starts a scan.">
          <SettingSelect
            ariaLabel="Scan cadence"
            value={draft.cadenceHours}
            options={[
              [1, "Every hour"],
              [3, "Every 3 hours"],
              [6, "Every 6 hours"],
              [12, "Every 12 hours"],
              [24, "Daily"],
            ]}
            onChange={(cadenceHours) => setDraft((value) => ({ ...value, cadenceHours }))}
          />
        </SettingRow>
        <SettingRow
          label="Observation window"
          description="The recent period treated as current behavior."
        >
          <SettingSelect
            ariaLabel="Observation window"
            value={draft.observationMinutes}
            options={[
              [15, "15 minutes"],
              [30, "30 minutes"],
              [60, "1 hour"],
              [180, "3 hours"],
            ]}
            onChange={(observationMinutes) =>
              setDraft((value) => ({ ...value, observationMinutes }))
            }
          />
        </SettingRow>
        <SettingRow
          label="Baseline window"
          description="The historical period immediately before the observation window."
        >
          <SettingSelect
            ariaLabel="Baseline window"
            value={draft.baselineHours}
            options={[
              [6, "6 hours"],
              [12, "12 hours"],
              [24, "24 hours"],
              [48, "48 hours"],
              [168, "7 days"],
            ]}
            onChange={(baselineHours) => setDraft((value) => ({ ...value, baselineHours }))}
          />
        </SettingRow>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/40 px-5 py-4">
        <Btn variant="secondary" disabled={!changed || saving} onClick={() => setDraft(settings)}>
          Reset
        </Btn>
        <Btn disabled={!changed} loading={saving} onClick={() => onSave(draft)}>
          Save changes
        </Btn>
      </div>
    </section>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-lg">
        <div className="text-[12px] font-medium text-fg">{label}</div>
        <div className="mt-1 text-[11px] leading-5 text-muted">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SettingSelect({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: number;
  options: Array<[number, string]>;
  onChange: (value: number) => void;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="h-8 min-w-40 rounded-md border border-border bg-surface-2 px-2.5 text-[12px] text-fg focus:border-border-strong focus:outline-none"
    >
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-4">
      <div className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-2 text-[20px] font-semibold tracking-tight text-fg">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{detail}</div>
    </div>
  );
}

function ScanStatusIcon({ status }: { status: "running" | "completed" | "failed" }) {
  const className =
    status === "completed"
      ? "text-success"
      : status === "failed"
        ? "text-danger"
        : "animate-pulse text-accent";
  if (status === "completed")
    return <CheckCircleIcon size={18} weight="fill" className={className} aria-hidden />;
  if (status === "failed")
    return <WarningCircleIcon size={18} weight="fill" className={className} aria-hidden />;
  return <ClockIcon size={18} className={className} aria-hidden />;
}

function statusTone(status: "running" | "completed" | "failed") {
  return status === "completed" ? "success" : status === "failed" ? "danger" : "accent";
}

function statusLabel(status: "running" | "completed" | "failed") {
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

function relativeDate(value: string) {
  const elapsed = Date.now() - Date.parse(value);
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.round(elapsed / 60_000))}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.round(elapsed / (60 * 60_000))}h ago`;
  return formatDate(value);
}

function duration(startedAt: string, completedAt: string | null) {
  if (!completedAt) return "In progress";
  const seconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
