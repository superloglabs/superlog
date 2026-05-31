import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  type AdminEvalsOverview,
  type IncidentEvalFixture,
  type InvestigationEvalFixture,
  useAdminEvals,
  useAdminFeedbackUnreadCount,
} from "./api";
import { useSession } from "./auth-client.ts";

export function Evals() {
  const { data: session, isPending } = useSession();
  // Staff gating is server-side via STAFF_EMAILS — a 403 surfaces as
  // "Not found." here so we don't leak the existence of /admin/* to
  // random signed-in users.
  const evals = useAdminEvals(!!session);

  if (isPending) {
    return <div className="py-12 text-center text-sm text-muted">Loading…</div>;
  }
  if (evals.error && (evals.error as Error).message.startsWith("403")) {
    return <div className="py-12 text-center text-sm text-muted">Not found.</div>;
  }

  return (
    <div className="space-y-6">
      <AdminSubnav />
      {evals.isLoading && <div className="py-12 text-center text-sm text-muted">Loading…</div>}
      {evals.error && (
        <div className="py-12 text-center text-sm text-muted">
          Failed to load: {(evals.error as Error).message}
        </div>
      )}
      {evals.data && <EvalsBody data={evals.data} />}
    </div>
  );
}

export function AdminSubnav() {
  const { pathname } = useLocation();
  // Always enabled — admin pages already gate at the page level, and the
  // request 403s for non-staff (which we silently swallow into a 0 badge).
  const unread = useAdminFeedbackUnreadCount(true);
  const unreadCount = unread.data?.count ?? 0;

  const tabs: { href: string; label: string; badge?: number }[] = [
    { href: "/admin", label: "Org overview" },
    { href: "/admin/evals", label: "Evals" },
    { href: "/admin/feedback", label: "Feedback", badge: unreadCount },
  ];
  return (
    <div className="flex items-center gap-5 border-b border-border pb-2">
      {tabs.map((t) => {
        const active = t.href === "/admin" ? pathname === "/admin" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            to={t.href}
            className={
              active
                ? "flex items-center gap-2 text-[13px] font-medium text-fg underline underline-offset-[6px] decoration-1"
                : "flex items-center gap-2 text-[13px] font-medium text-muted transition-opacity hover:text-fg"
            }
          >
            {t.label}
            {typeof t.badge === "number" && t.badge > 0 && (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 font-mono text-[10px] font-medium tabular-nums text-accent-ink">
                {t.badge > 99 ? "99+" : t.badge}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

type EvalTab = "incident-summarization" | "investigations";

function EvalsBody({ data }: { data: AdminEvalsOverview }) {
  const [tab, setTab] = useState<EvalTab>("incident-summarization");

  const tabs: { id: EvalTab; label: string; count: number }[] = [
    {
      id: "incident-summarization",
      label: "Incident summarization",
      count: data.incidentSummarization.fixtures.length,
    },
    {
      id: "investigations",
      label: "Investigations",
      count: data.investigations.fixtures.length,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-medium tracking-tight">Evals</h1>
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle">
          read-only · fixtures on disk
        </span>
      </div>

      <div className="flex items-center gap-1">
        {tabs.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={
                active
                  ? "flex items-center gap-2 rounded-md bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-fg"
                  : "flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-fg"
              }
            >
              {t.label}
              <span className="font-mono text-[11px] tabular-nums text-subtle">{t.count}</span>
            </button>
          );
        })}
      </div>

      {tab === "incident-summarization" ? (
        <IncidentSummarizationSection data={data.incidentSummarization} />
      ) : (
        <InvestigationsSection data={data.investigations} />
      )}
    </div>
  );
}

function IncidentSummarizationSection({
  data,
}: {
  data: AdminEvalsOverview["incidentSummarization"];
}) {
  const [openFile, setOpenFile] = useState<string | null>(null);

  if (data.readError) {
    return (
      <div className="border border-border bg-surface-2 p-4 text-[13px] text-muted">
        Couldn't read fixtures from{" "}
        <code className="font-mono text-[11px] text-fg">{data.fixturesDir}</code>: {data.readError}
      </div>
    );
  }

  if (data.fixtures.length === 0) {
    return (
      <div className="border border-border bg-surface-2 p-4 text-[13px] text-muted">
        No fixtures found in{" "}
        <code className="font-mono text-[11px] text-fg">{data.fixturesDir}</code>.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted">
        Frozen incident-summarization fixtures used by{" "}
        <code className="font-mono text-[11px] text-fg">apps/worker/evals/run.ts</code>. Each row is
        one captured prod incident plus its human-labelled reference output.
      </p>

      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left">
              <Th>Codename</Th>
              <Th>Captured</Th>
              <Th>Reference title</Th>
              <Th>Human label</Th>
              <Th align="right"> </Th>
            </tr>
          </thead>
          <tbody>
            {data.fixtures.map((f) => {
              const isOpen = openFile === f.file;
              return (
                <FixtureRow
                  key={f.file}
                  fixture={f}
                  open={isOpen}
                  onToggle={() => setOpenFile(isOpen ? null : f.file)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[11px] text-subtle">
        Source: <span className="text-fg">{data.fixturesDir}</span>
      </p>
    </div>
  );
}

function InvestigationsSection({
  data,
}: {
  data: AdminEvalsOverview["investigations"];
}) {
  if (data.readError) {
    return (
      <div className="border border-border bg-surface-2 p-4 text-[13px] text-muted">
        Couldn't read fixtures from{" "}
        <code className="font-mono text-[11px] text-fg">{data.fixturesDir}</code>: {data.readError}
      </div>
    );
  }

  if (data.fixtures.length === 0) {
    return (
      <div className="border border-border bg-surface-2 p-4 text-[13px] text-muted">
        No fixtures found in{" "}
        <code className="font-mono text-[11px] text-fg">{data.fixturesDir}</code>.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted">
        Agentic investigation fixtures used by{" "}
        <code className="font-mono text-[11px] text-fg">scripts/eval-investigations.ts</code>. Each
        row is a captured prod incident with a code snapshot and telemetry the agent must diagnose.
        The list only shows answer-key presence (
        <code className="font-mono text-[11px] text-fg">ground_truth.md</code> +{" "}
        <code className="font-mono text-[11px] text-fg">rubric.json</code>); open a row to inspect
        the full fixture.
      </p>

      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left">
              <Th>Slug</Th>
              <Th>Incident title</Th>
              <Th>Service</Th>
              <Th>Window</Th>
              <Th>Telemetry</Th>
              <Th>Fixture</Th>
            </tr>
          </thead>
          <tbody>
            {data.fixtures.map((f) => (
              <InvestigationRow key={f.slug} fixture={f} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[11px] text-subtle">
        Source: <span className="text-fg">{data.fixturesDir}</span>
      </p>
    </div>
  );
}

function InvestigationRow({ fixture }: { fixture: InvestigationEvalFixture }) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-surface-2/50 align-top">
      <td className="px-3 py-2.5">
        <Link
          to={`/admin/evals/investigations/${fixture.slug}`}
          className="font-mono text-[12px] text-fg underline-offset-2 hover:underline"
        >
          {fixture.slug}
        </Link>
        <div className="font-mono text-[10px] text-subtle">{fixture.incidentId}</div>
      </td>
      <td className="px-3 py-2.5">
        <Link
          to={`/admin/evals/investigations/${fixture.slug}`}
          className="underline-offset-2 hover:underline"
        >
          {fixture.title || "—"}
        </Link>
      </td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-muted">{fixture.service ?? "—"}</td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-subtle whitespace-nowrap">
        {fixture.window.since ? (
          <>
            {fmtDate(fixture.window.since)}
            <span className="text-border"> → </span>
            {fixture.window.until ? fmtDate(fixture.window.until) : "?"}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap gap-1">
          {fixture.telemetryTables.length === 0 ? (
            <span className="text-subtle">—</span>
          ) : (
            fixture.telemetryTables.map((t) => (
              <span
                key={t}
                className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted"
              >
                {t}
              </span>
            ))
          )}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap gap-1">
          <Tag on={fixture.hasCode}>code</Tag>
          <Tag on={fixture.hasGroundTruth}>ground truth</Tag>
          <Tag on={fixture.hasRubric}>rubric</Tag>
        </div>
      </td>
    </tr>
  );
}

function Tag({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={
        on
          ? "rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-fg"
          : "rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-subtle line-through"
      }
    >
      {children}
    </span>
  );
}

function FixtureRow({
  fixture,
  open,
  onToggle,
}: {
  fixture: IncidentEvalFixture;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-border last:border-b-0 hover:bg-surface-2/50">
        <td className="px-3 py-2.5">
          <div className="font-medium">{fixture.codename ?? "—"}</div>
          <div className="font-mono text-[11px] text-subtle">{fixture.file}</div>
        </td>
        <td className="px-3 py-2.5 font-mono text-[11px] text-subtle">
          {fmtDate(fixture.capturedAt)}
        </td>
        <td className="px-3 py-2.5">{fixture.referenceOutput.title || "—"}</td>
        <td className="px-3 py-2.5">
          <div className="font-mono text-[11px] uppercase tracking-[0.15em] text-subtle">
            {fixture.humanLabel.title || "—"}
          </div>
          {fixture.humanLabel.summary &&
            fixture.humanLabel.summary !== fixture.humanLabel.title && (
              <div className="text-[12px] text-muted">{fixture.humanLabel.summary}</div>
            )}
        </td>
        <td className="px-3 py-2.5 text-right">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="font-mono text-[11px] text-subtle hover:text-fg"
          >
            {open ? "hide ▴" : "show ▾"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-surface-2/30">
          <td colSpan={5} className="space-y-4 px-3 py-4">
            <Block label="Incident id">
              <code className="font-mono text-[11px] text-fg">{fixture.incidentId}</code>
            </Block>
            <Block label="User prompt">
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed text-fg">
                {fixture.userPrompt}
              </pre>
            </Block>
            <Block label="Reference output">
              <div className="space-y-1 border border-border bg-surface p-3 text-[12px]">
                <div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-subtle">
                    title
                  </span>
                  <div>{fixture.referenceOutput.title || "—"}</div>
                </div>
                {fixture.referenceOutput.summary && (
                  <div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-subtle">
                      summary
                    </span>
                    <div>{fixture.referenceOutput.summary}</div>
                  </div>
                )}
              </div>
            </Block>
            {fixture.humanLabel.notes && (
              <Block label="Human notes">
                <div className="border border-border bg-surface p-3 text-[12px] text-muted">
                  {fixture.humanLabel.notes}
                </div>
              </Block>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">{label}</div>
      {children}
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-3 py-2 font-mono text-[10px] font-normal uppercase tracking-[0.2em] text-subtle ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
