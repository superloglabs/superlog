import type { ReactNode } from "react";
import type { IncidentEvent, Issue } from "../api.ts";
import { Btn, Chip } from "../design/ui.tsx";

export type IssueDetailViewProps = {
  issue: Issue;
  environment: string | null;
  onBack: () => void;
  onToggleSilence?: () => void;
  onOpenEvidence?: () => void;
  evidenceLabel?: string;
  silenceUpdating?: boolean;
  timelineEvents?: IncidentEvent[];
  linkedIncident?: ReactNode;
  feedbackAction?: ReactNode;
};

export function IssueDetailView({
  issue,
  environment,
  onBack,
  onToggleSilence,
  onOpenEvidence,
  evidenceLabel = "Open event",
  silenceUpdating = false,
  timelineEvents = [],
  linkedIncident,
  feedbackAction,
}: IssueDetailViewProps) {
  const silenced = Boolean(issue.silencedAt) || issue.status === "silenced";
  const sample = issue.lastSample;
  const stacktrace = issue.symbolication?.stacktrace ?? sample?.stacktrace ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg text-fg" data-issue-detail-workspace="true">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-bg px-5 py-3">
        <button
          type="button"
          onClick={onBack}
          className="text-[13px] text-muted transition-colors hover:text-fg"
        >
          Errors
        </button>
        <span className="text-subtle">›</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{issue.title}</span>
        <div className="flex shrink-0 items-center gap-2">
          {onToggleSilence && (
            <Btn variant="secondary" size="sm" onClick={onToggleSilence} loading={silenceUpdating}>
              {silenced ? "Unsilence" : "Silence"}
            </Btn>
          )}
          <button
            type="button"
            onClick={onBack}
            className="grid h-7 w-7 place-items-center text-muted transition-colors hover:text-fg"
            aria-label="Back to errors"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="min-w-0 border-b border-border bg-bg lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="px-6 pb-7 pt-7 lg:px-7">
            <div className="flex flex-wrap items-center gap-2">
              <KindChip kind={issue.kind} />
              <StatusChip issue={issue} />
              {issue.groupingState === "grouped" && <Chip tone="neutral">grouped</Chip>}
              {issue.groupingState === "pending" && <Chip tone="warning">analysing</Chip>}
              {issue.groupingState === "failed" && <Chip tone="danger">grouping failed</Chip>}
            </div>

            <div className="mt-5 text-[11px] text-subtle">{issue.exceptionType}</div>
            <h1 className="mt-2 break-words text-[22px] font-semibold leading-[1.12] tracking-tight text-fg">
              {issue.title}
            </h1>
            {issue.message && (
              <p className="mt-4 break-words text-[12.5px] leading-5 text-muted">{issue.message}</p>
            )}

            <dl className="mt-7 grid gap-3.5">
              <MetaRow label="Status" value={statusLabel(issue)} />
              <MetaRow label="Service" value={issue.service ?? "Not recorded"} />
              <MetaRow label="Environment" value={environment ?? "Not recorded"} />
              <MetaRow
                label="Activity"
                value={`${formatCount(issue.eventCount)} event${issue.eventCount === 1 ? "" : "s"}`}
              />
              <MetaRow label="First seen" value={formatTimestamp(issue.firstSeen)} />
              <MetaRow label="Last seen" value={formatTimestamp(issue.lastSeen)} />
              <MetaRow label="Grouping" value={groupingLabel(issue)} />
            </dl>

            {linkedIncident && (
              <section className="mt-7 border-t border-border pt-6">
                <SectionLabel>Linked incident</SectionLabel>
                <div className="mt-2">{linkedIncident}</div>
              </section>
            )}

            <div className="mt-7 grid gap-2">
              {onOpenEvidence && (
                <Btn
                  variant="primary"
                  size="sm"
                  onClick={onOpenEvidence}
                  className="w-full justify-center"
                >
                  {evidenceLabel}
                </Btn>
              )}
              {feedbackAction}
            </div>
          </div>
        </aside>

        <main className="min-h-0 min-w-0 overflow-y-auto bg-bg px-5 py-7 sm:px-7 lg:px-10">
          <div className="mx-auto w-full max-w-[900px] space-y-9">
            <section>
              <SectionLabel>Error overview</SectionLabel>
              <h2 className="mt-2 text-[18px] font-semibold tracking-tight text-fg">
                A recurring failure in {issue.service ?? "an unknown service"}
              </h2>
              <p className="mt-3 max-w-[760px] text-[13px] leading-6 text-muted">
                {issue.message ??
                  "Superlog grouped matching telemetry into this error. Open the latest event to inspect the original signal."}
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <OverviewMetric
                  label="Occurrences"
                  value={formatCount(issue.eventCount)}
                  detail="matching events"
                />
                <OverviewMetric
                  label="First detected"
                  value={formatShortDate(issue.firstSeen)}
                  detail={formatShortTime(issue.firstSeen)}
                />
                <OverviewMetric
                  label="Latest detected"
                  value={formatShortDate(issue.lastSeen)}
                  detail={formatShortTime(issue.lastSeen)}
                />
              </div>
            </section>

            <IssueActivityTimeline issueId={issue.id} events={timelineEvents} />

            <section className="border-t border-border pt-7">
              <SectionLabel>Latest evidence</SectionLabel>
              <div className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
                <EvidenceRow label="Exception" value={issue.exceptionType} />
                <EvidenceRow
                  label="Top frame"
                  value={issue.topFrame ?? sample?.topFrame ?? "No frame was captured"}
                />
                <EvidenceRow
                  label="Signal"
                  value={`${kindLabel(issue.kind)} from ${issue.service ?? "unknown service"}`}
                />
                {sample?.severity && <EvidenceRow label="Severity" value={sample.severity} />}
              </div>
            </section>

            {stacktrace && (
              <section className="border-t border-border pt-7">
                <SectionLabel>Stack trace</SectionLabel>
                <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface px-4 py-3 font-sans text-[12px] leading-5 text-muted">
                  {stacktrace}
                </pre>
              </section>
            )}

            {issue.groupingReason && (
              <section className="border-t border-border pt-7">
                <SectionLabel>Why these events were grouped</SectionLabel>
                <p className="mt-3 max-w-[760px] text-[13px] leading-6 text-muted">
                  {issue.groupingReason}
                </p>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function IssueActivityTimeline({ issueId, events }: { issueId: string; events: IncidentEvent[] }) {
  const items = events.flatMap((event) => {
    const presentation =
      event.kind === "issue_silenced"
        ? { status: "Silenced", tone: "neutral" as const }
        : event.kind === "issue_observed"
          ? { status: "Under observation", tone: "warning" as const }
          : event.kind === "issue_resolved"
            ? { status: "Resolved", tone: "success" as const }
            : null;
    if (!presentation || event.detail?.issueId !== issueId) return [];
    const reason = typeof event.detail.reason === "string" ? event.detail.reason.trim() : "";
    const evidence = typeof event.detail.evidence === "string" ? event.detail.evidence.trim() : "";
    return [{ event, reason, evidence, ...presentation }];
  });
  if (items.length === 0) return null;

  return (
    <section className="border-t border-border pt-7">
      <SectionLabel>Activity</SectionLabel>
      <div className="relative mt-5 space-y-5 pl-6">
        {items.length > 1 && (
          <div className="absolute bottom-2 left-[5px] top-2 w-px bg-border" aria-hidden="true" />
        )}
        {items.map(({ event, reason, evidence, status, tone }) => (
          <article key={event.id} className="relative">
            <span
              className="absolute -left-6 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-border-strong bg-bg"
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Chip tone={tone}>{status}</Chip>
              <time className="text-[11px] text-subtle" dateTime={event.createdAt}>
                {formatTimestamp(event.createdAt)}
              </time>
            </div>
            {reason && <p className="mt-2 text-[13px] leading-5 text-fg">{reason}</p>}
            {evidence && <p className="mt-1.5 text-[12px] leading-5 text-muted">{evidence}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}

function KindChip({ kind }: { kind: string }) {
  const tone = kind === "log" ? "accent" : kind === "alert" ? "warning" : "neutral";
  return <Chip tone={tone}>{kindLabel(kind)}</Chip>;
}

function StatusChip({ issue }: { issue: Issue }) {
  const tone =
    issue.status === "resolved"
      ? "success"
      : issue.status === "under_observation"
        ? "warning"
        : issue.status === "silenced"
          ? "neutral"
          : "danger";
  return (
    <Chip tone={tone} dot>
      {statusLabel(issue)}
    </Chip>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-3 text-[12px]">
      <dt className="text-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{value}</dd>
    </div>
  );
}

function OverviewMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3.5">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="mt-2 text-[20px] font-semibold tracking-tight text-fg">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{detail}</div>
    </div>
  );
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="break-words text-[12.5px] leading-5 text-fg">{value}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium text-subtle">{children}</div>;
}

function statusLabel(issue: Issue) {
  if (issue.status === "under_observation") return "Under observation";
  return issue.status.charAt(0).toUpperCase() + issue.status.slice(1);
}

function groupingLabel(issue: Issue) {
  if (issue.groupingState === "grouped") return "Grouped into an incident";
  if (issue.groupingState === "pending") return "Analysis in progress";
  if (issue.groupingState === "failed") return "Grouping failed";
  return "Standalone error";
}

function kindLabel(kind: string) {
  return kind === "span" ? "Trace" : kind.charAt(0).toUpperCase() + kind.slice(1);
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

function formatShortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function CloseIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
