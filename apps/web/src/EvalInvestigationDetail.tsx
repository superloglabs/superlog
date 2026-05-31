import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AdminSubnav } from "./Evals.tsx";
import { type InvestigationEvalDetail, useAdminInvestigationEval } from "./api";
import { useSession } from "./auth-client.ts";
import {
  type RubricLine,
  describeRubric,
  summarizeTelemetryRows,
} from "./eval-investigation-format.ts";

export function EvalInvestigationDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { data: session, isPending } = useSession();
  const detail = useAdminInvestigationEval(slug, !!session);

  if (isPending) {
    return <div className="py-12 text-center text-sm text-muted">Loading…</div>;
  }
  if (detail.error && (detail.error as Error).message.startsWith("403")) {
    return <div className="py-12 text-center text-sm text-muted">Not found.</div>;
  }

  return (
    <div className="space-y-6">
      <AdminSubnav />
      <Link
        to="/admin/evals"
        className="inline-block font-mono text-[11px] text-subtle hover:text-fg"
      >
        ← back to evals
      </Link>
      {detail.isLoading && <div className="py-12 text-center text-sm text-muted">Loading…</div>}
      {detail.error && (
        <div className="py-12 text-center text-sm text-muted">
          {(detail.error as Error).message.startsWith("404")
            ? "Investigation fixture not found."
            : `Failed to load: ${(detail.error as Error).message}`}
        </div>
      )}
      {detail.data && <DetailBody data={detail.data} />}
    </div>
  );
}

function DetailBody({ data }: { data: InvestigationEvalDetail }) {
  if (data.readError) {
    return (
      <div className="border border-border bg-surface-2 p-4 text-[13px] text-muted">
        Couldn't read this fixture: {data.readError}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle">
          investigation fixture
        </div>
        <h1 className="mt-1 text-2xl font-medium tracking-tight">
          {data.incident.title || data.slug}
        </h1>
        <div className="mt-2 font-mono text-[11px] text-subtle">{data.slug}</div>
      </div>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-[13px] sm:grid-cols-4">
        <Meta label="Incident id" value={data.incident.id || "—"} mono />
        <Meta label="Service" value={data.incident.service ?? "—"} mono />
        <Meta
          label="Window"
          value={
            data.incident.window.since
              ? `${fmt(data.incident.window.since)} → ${
                  data.incident.window.until ? fmt(data.incident.window.until) : "?"
                }`
              : "—"
          }
          mono
        />
        <Meta
          label="Code"
          value={data.code ? `${data.code.artifact} (${fmtBytes(data.code.bytes)})` : "—"}
          mono
        />
      </dl>

      <Section title="Ground truth" subtitle="evals/.../ground_truth.md · the grader's answer key">
        {data.groundTruth ? (
          <Pre>{data.groundTruth}</Pre>
        ) : (
          <Empty>No ground_truth.md in this fixture.</Empty>
        )}
      </Section>

      <Section title="Rubric" subtitle="evals/.../rubric.json · grading concepts">
        {data.rubric != null ? (
          <RubricSummary rubric={data.rubric} />
        ) : (
          <Empty>No rubric.json in this fixture.</Empty>
        )}
      </Section>

      <Section title="Telemetry" subtitle="the evidence the agent must diagnose (sampled)">
        {data.telemetry.length === 0 ? (
          <Empty>No telemetry files declared.</Empty>
        ) : (
          <div className="space-y-4">
            {data.telemetry.map((t) => (
              <TelemetryBlock key={t.path} telemetry={t} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Postgres" subtitle="incident / issues / project rows captured from prod">
        {data.postgres.length === 0 ? (
          <Empty>No postgres fixture files.</Empty>
        ) : (
          <div className="space-y-2">
            {data.postgres.map((p) => (
              <Collapsible key={p.file} label={p.file}>
                <Pre>{JSON.stringify(p.json, null, 2)}</Pre>
              </Collapsible>
            ))}
          </div>
        )}
      </Section>

      <Section title="fixture.json" subtitle="the contract consumed by the runner">
        <Pre>{JSON.stringify(data.fixture, null, 2)}</Pre>
      </Section>

      <p className="font-mono text-[11px] text-subtle">
        Source:{" "}
        <span className="text-fg">
          {data.fixturesDir}/{data.slug}
        </span>
      </p>
    </div>
  );
}

function TelemetryBlock({
  telemetry,
}: {
  telemetry: InvestigationEvalDetail["telemetry"][number];
}) {
  const capped = telemetry.sample.length < telemetry.rowCount;
  const summary = summarizeTelemetryRows(telemetry.sample);
  return (
    <Collapsible
      defaultOpen
      label={
        <span className="flex items-center gap-2">
          <span className="font-mono text-[12px] text-fg">{telemetry.table}</span>
          <span className="font-mono text-[10px] text-subtle">
            {telemetry.rowCount} row{telemetry.rowCount === 1 ? "" : "s"}
            {capped ? ` · showing first ${telemetry.sample.length}` : ""}
          </span>
        </span>
      }
    >
      <div className="mb-1 font-mono text-[10px] text-subtle">{telemetry.path}</div>
      {telemetry.sample.length === 0 ? (
        <Empty>No rows captured.</Empty>
      ) : (
        <div className="space-y-4">
          <TelemetrySummary summary={summary} />
          <Collapsible label="Raw sampled rows">
            <Pre>{telemetry.sample.map((r) => JSON.stringify(r)).join("\n")}</Pre>
          </Collapsible>
        </div>
      )}
    </Collapsible>
  );
}

function RubricSummary({ rubric }: { rubric: unknown }) {
  const sections = describeRubric(rubric);
  if (sections.length === 0) return <Pre>{JSON.stringify(rubric, null, 2)}</Pre>;
  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section.title} className="border border-border bg-surface">
          <div className="border-b border-border bg-surface-2 px-3 py-2 text-[13px] font-medium">
            {section.title}
          </div>
          <dl className="divide-y divide-border">
            {section.lines.map((line) => (
              <RubricLineView key={`${section.title}:${line.label}`} line={line} />
            ))}
          </dl>
        </div>
      ))}
      <Collapsible label="Raw rubric.json">
        <Pre>{JSON.stringify(rubric, null, 2)}</Pre>
      </Collapsible>
    </div>
  );
}

function RubricLineView({ line }: { line: RubricLine }) {
  return (
    <div className="grid gap-1 px-3 py-2 text-[12px] sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-subtle">
        {line.label}
      </dt>
      <dd className="text-fg">
        {Array.isArray(line.value) ? (
          <ul className="space-y-1">
            {line.value.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          line.value
        )}
      </dd>
    </div>
  );
}

function TelemetrySummary({ summary }: { summary: ReturnType<typeof summarizeTelemetryRows> }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-4">
        <CountList title="Services" rows={summary.services} />
        <CountList title="Span names" rows={summary.spanNames} />
        <CountList title="Statuses" rows={summary.statuses} />
        <CountList
          title="Routes"
          rows={summary.routes.map((r) => ({ name: r.route, count: r.count }))}
        />
      </div>

      {summary.exceptions.length > 0 && (
        <div className="border border-border">
          <div className="border-b border-border bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em] text-subtle">
            Exceptions
          </div>
          <div className="divide-y divide-border">
            {summary.exceptions.map((ex) => (
              <div key={`${ex.type}:${ex.message}:${ex.stackTop ?? ""}`} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12px] text-fg">{ex.type}</span>
                  <span className="font-mono text-[10px] text-subtle">
                    {ex.count} occurrence{ex.count === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-fg">{ex.message}</div>
                {ex.stackTop && (
                  <div className="mt-1 font-mono text-[11px] text-subtle">{ex.stackTop}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {summary.notableRows.length > 0 && (
        <div className="overflow-x-auto border border-border">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left">
                <SmallTh>Time</SmallTh>
                <SmallTh>Service</SmallTh>
                <SmallTh>Span</SmallTh>
                <SmallTh>Status</SmallTh>
                <SmallTh>HTTP</SmallTh>
                <SmallTh>Duration</SmallTh>
                <SmallTh>Route / URL</SmallTh>
                <SmallTh>Error</SmallTh>
              </tr>
            </thead>
            <tbody>
              {summary.notableRows.map((row, index) => (
                <tr
                  key={`${row.timestamp}:${row.service}:${row.spanName}:${index}`}
                  className="border-b border-border last:border-b-0 align-top"
                >
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-subtle">
                    {fmt(row.timestamp)}
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px]">{row.service}</td>
                  <td className="px-2 py-2 font-mono text-[11px]">{row.spanName}</td>
                  <td className="px-2 py-2 font-mono text-[11px]">{row.status}</td>
                  <td className="px-2 py-2 font-mono text-[11px]">{row.httpStatus}</td>
                  <td className="px-2 py-2 font-mono text-[11px]">{row.durationMs} ms</td>
                  <td className="min-w-[18rem] px-2 py-2 font-mono text-[11px] text-muted">
                    {row.route}
                  </td>
                  <td className="px-2 py-2 text-[12px] text-fg">{row.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CountList({
  title,
  rows,
}: { title: string; rows: Array<{ name: string; count: number }> }) {
  return (
    <div className="border border-border">
      <div className="border-b border-border bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em] text-subtle">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-subtle">—</div>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((row) => (
            <div key={row.name} className="flex items-start justify-between gap-3 px-3 py-1.5">
              <span className="break-all font-mono text-[11px] text-fg">{row.name}</span>
              <span className="font-mono text-[11px] tabular-nums text-subtle">{row.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SmallTh({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-2 py-1.5 font-mono text-[10px] font-normal uppercase tracking-[0.15em] text-subtle">
      {children}
    </th>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-3 border-b border-border pb-1">
        <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
        {subtitle && <span className="font-mono text-[11px] text-subtle">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function Collapsible({
  label,
  children,
  defaultOpen = false,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 bg-surface-2 px-3 py-2 text-left hover:bg-surface-2/70"
      >
        {typeof label === "string" ? <span className="font-mono text-[12px]">{label}</span> : label}
        <span className="font-mono text-[11px] text-subtle">{open ? "hide ▴" : "show ▾"}</span>
      </button>
      {open && <div className="p-3">{children}</div>}
    </div>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed text-fg">
      {children}
    </pre>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] text-subtle">{children}</div>;
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-subtle">{label}</dt>
      <dd className={mono ? "font-mono text-[12px] text-fg" : "text-[13px] text-fg"}>{value}</dd>
    </div>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
