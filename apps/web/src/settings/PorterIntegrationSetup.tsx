import { useState } from "react";
import { usePorterSetup } from "../api.ts";
import { Btn, Label, SkeletonBlock } from "../design/ui.tsx";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "../onboarding/icons.tsx";

const PORTER_SETUP_DETAILS = {
  dashboardUrl: "https://dashboard.porter.run",
  addonName: "superlog-otel",
  chart: {
    repositoryUrl: "https://superloglabs.github.io/helm-charts",
    name: "superlog-otel",
    version: "0.1.1",
  },
} as const;

export function PorterIntegrationSetup({ projectId }: { projectId: string | undefined }) {
  const setup = usePorterSetup(projectId ?? "");
  const [copied, setCopied] = useState(false);

  const regenerate = () => {
    if (!projectId || setup.isFetching) return;
    setCopied(false);
    setup.refetch();
  };

  const copyValues = () => {
    if (!setup.data) return;
    navigator.clipboard?.writeText(setup.data.valuesYaml).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (!projectId) {
    return <p className="text-[13px] text-danger">Select a project before connecting Porter.</p>;
  }

  const data = setup.data;
  const details = data ?? PORTER_SETUP_DETAILS;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-accent/30 bg-accent-soft/20 px-4 py-3">
        <p className="text-[13px] leading-5 text-fg">
          {data
            ? "A fresh, project-scoped ingest key is already included below. "
            : "The Porter fields are ready while we generate a project-scoped ingest key. "}
          No terminal commands or Kubernetes access are needed.
        </p>
      </div>

      <SetupStep number="1" title="Create a Helm Chart add-on in Porter">
        <p className="mb-3 text-[12.5px] leading-5 text-muted">
          Open <span className="text-fg">Add-ons → New add-on → Helm Chart</span>, then enter these
          values.
        </p>
        <div className="overflow-hidden rounded-lg border border-border bg-bg/30">
          <SetupField label="Add-on name" value={details.addonName} />
          <SetupField label="Helm Repository URL" value={details.chart.repositoryUrl} />
          <SetupField label="Chart Name" value={details.chart.name} />
          <SetupField label="Chart Version" value={details.chart.version} last />
        </div>
      </SetupStep>

      <SetupStep number="2" title="Paste the generated Values YAML">
        {data ? (
          <div className="overflow-hidden rounded-lg border border-border bg-[#0a0a0c]">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <Label>Values YAML</Label>
              <Btn
                size="sm"
                variant="secondary"
                onClick={copyValues}
                className="!h-7 !border-0 !bg-surface-2"
              >
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                {copied ? "Copied" : "Copy"}
              </Btn>
            </div>
            <pre className="superlog-code overflow-x-auto px-4 py-3 text-[12.5px] leading-5 text-fg">
              {data.valuesYaml}
            </pre>
          </div>
        ) : setup.isFetching ? (
          <div
            className="space-y-3 rounded-lg border border-border bg-bg/30 p-4"
            aria-live="polite"
          >
            <p className="text-[12.5px] text-muted">Generating your project ingest key…</p>
            <SkeletonBlock className="h-12 rounded-md" />
          </div>
        ) : setup.error ? (
          <div
            className="space-y-3 rounded-lg border border-danger/30 bg-danger/5 p-4"
            role="alert"
          >
            <p className="text-[13px] text-danger">
              Could not generate the ingest key. Nothing was deployed or changed in Porter.
            </p>
            <Btn size="sm" variant="secondary" onClick={regenerate}>
              Try again
            </Btn>
          </div>
        ) : (
          <p className="text-[12.5px] text-muted">Open this integration again to generate a key.</p>
        )}
      </SetupStep>

      <SetupStep number="3" title="Deploy the add-on">
        <p className="text-[12.5px] leading-5 text-muted">
          Select <span className="text-fg">Deploy</span>. Porter installs the collector and starts
          sending Kubernetes logs, metrics, events, and application OTLP signals to this project.
        </p>
      </SetupStep>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <a
          href={details.dashboardUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-fg px-3 text-[13px] font-medium tracking-tight text-bg transition-colors hover:bg-fg/90"
        >
          Open Porter
          <ExternalLinkIcon size={13} />
        </a>
        {data ? (
          <Btn
            size="md"
            variant="ghost"
            onClick={regenerate}
            loading={setup.isFetching}
            className="text-muted"
          >
            Generate another key
          </Btn>
        ) : null}
      </div>

      <p className="text-[11.5px] leading-5 text-subtle">
        This key can only ingest telemetry. Generating another key does not revoke a key already in
        use, so an existing Porter collector keeps working.
      </p>
    </div>
  );
}

function SetupStep({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid h-5 w-5 place-items-center rounded-full border border-border-strong text-[10px] font-semibold text-muted">
          {number}
        </span>
        <h3 className="text-[13px] font-medium text-fg">{title}</h3>
      </div>
      <div className="pl-[30px]">{children}</div>
    </section>
  );
}

function SetupField({
  label,
  value,
  last = false,
}: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`grid gap-1 px-3 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)] ${last ? "" : "border-b border-border"}`}
    >
      <span className="text-[11.5px] text-subtle">{label}</span>
      <code className="break-all font-mono text-[12px] text-fg">{value}</code>
    </div>
  );
}
