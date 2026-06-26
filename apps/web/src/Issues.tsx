import { ChartIncreaseIcon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { type EvidenceLinkContext, EvidenceMarkdown } from "./EvidenceMarkdown.tsx";
import { FeedbackTrigger } from "./FeedbackDialog.tsx";
import { LogDrawer } from "./LogDetail.tsx";
import { TraceDrawer } from "./TraceDetail.tsx";
import {
  type AgentRun,
  type AgentRunEventActor,
  type Incident,
  type IncidentAlertEpisode,
  type IncidentEvent,
  type IncidentListItem,
  type IncidentPullRequest,
  type IncidentSeverity,
  type IncidentStats,
  type Issue,
  type IssueSample,
  type LogRow,
  type PendingResolutionProposal,
  useDecideResolutionProposal,
  useIncident,
  useIncidentPullRequests,
  useIncidentStats,
  useIncidents,
  useIssue,
  useIssueAgentRun,
  useIssues,
  useMe,
  useMergeIncidentPullRequest,
  useRestartAgentRun,
  useRetryPrDelivery,
  useSilenceIssue,
  useUnsilenceIssue,
  useUpdateIncident,
} from "./api.ts";
import { Btn, Chip } from "./design/ui.tsx";
import { getIncidentStatusAction } from "./incident-status-action.ts";
import { getIssueIncidentLinkState } from "./issue-incident-link-state.ts";

const IncidentPrDiffView = lazy(() => import("./IncidentPrDiffView.tsx"));

type IssueFilter = "active" | "silenced" | "all";
type IncidentStatus = "open" | "resolved" | "autoresolved_noise" | "all";
type Tab = "issues" | "incidents";

function tabBasePath(tab: Tab) {
  return tab === "issues" ? "/issues" : "/incidents";
}

function useTab(): Tab {
  const location = useLocation();
  return location.pathname.startsWith("/issues") ? "issues" : "incidents";
}

function useNav() {
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const tab = useTab();
  const id = params.id ?? null;

  function openItem(itemId: string, targetTab: Tab = tab) {
    navigate(`${tabBasePath(targetTab)}/${itemId}`);
  }
  function closeItem() {
    navigate(tabBasePath(tab), { replace: true });
  }
  return { tab, id, openItem, closeItem };
}

function useNearViewport<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    if (nearViewport) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "360px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nearViewport]);

  return [ref, nearViewport] as const;
}

export function Issues() {
  const me = useMe();
  if (me.isLoading) {
    return <div className="text-[13px] text-muted">Loading…</div>;
  }
  if (me.error || !me.data || !me.data.project) {
    return <div className="text-[13px] text-danger">Error: {String(me.error ?? "no session")}</div>;
  }
  return <IssuesShell projectId={me.data.project.id} />;
}

function IssuesShell({ projectId }: { projectId: string }) {
  const tab = useTab();
  const labels: Record<Tab, string> = { incidents: "Incidents", issues: "Issues" };
  return (
    <div>
      <div className="mb-6 flex items-center gap-1">
        {(["incidents", "issues"] as const).map((t) => (
          <Link
            key={t}
            to={tabBasePath(t)}
            replace={tab === t}
            className={
              tab === t
                ? "rounded-lg bg-surface-2 px-3 py-1.5 text-[13px] font-medium tracking-tight text-fg"
                : "rounded-lg px-3 py-1.5 text-[13px] font-medium tracking-tight text-muted hover:text-fg"
            }
          >
            {labels[t]}
          </Link>
        ))}
      </div>
      {tab === "issues" ? (
        <IssuesTab projectId={projectId} />
      ) : (
        <IncidentsTab projectId={projectId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issues tab
// ---------------------------------------------------------------------------

type EventTarget =
  | { kind: "trace"; traceId: string; spanId?: string }
  | { kind: "log"; log: LogRow }
  | null;

function IssuesTab({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<IssueFilter>("active");
  const [eventTarget, setEventTarget] = useState<EventTarget>(null);
  const { id: selectedId, openItem, closeItem } = useNav();
  const issues = useIssues(projectId, filter, { groupingFilter: "ungrouped" });
  const silence = useSilenceIssue(projectId);
  const unsilence = useUnsilenceIssue(projectId);

  const fromList = selectedId ? (issues.data?.find((i) => i.id === selectedId) ?? null) : null;
  const fetched = useIssue(projectId, selectedId && !fromList ? selectedId : undefined);
  const selected = fromList ?? fetched.data ?? null;

  function selectIssue(issueId: string | null) {
    if (issueId == null) closeItem();
    else openItem(issueId, "issues");
  }

  const tabs: { id: IssueFilter; label: string }[] = [
    { id: "active", label: "Active" },
    { id: "silenced", label: "Silenced" },
    { id: "all", label: "All" },
  ];

  function handleSilenceToggle(issue: Issue) {
    const mutation = issue.silencedAt ? unsilence : silence;
    mutation.mutate(issue.id);
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setFilter(t.id);
                selectIssue(null);
              }}
              className={
                filter === t.id
                  ? "rounded-lg bg-surface-2 px-3 py-1.5 text-[13px] font-medium tracking-tight text-fg"
                  : "rounded-lg px-3 py-1.5 text-[13px] font-medium tracking-tight text-muted hover:text-fg"
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        {issues.data && (
          <span className="text-[12px] text-muted">
            {issues.data.length} issue{issues.data.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {issues.isLoading && <div className="text-[13px] text-muted">Loading…</div>}
      {issues.error && (
        <div className="text-[13px] text-danger">Failed to load: {String(issues.error)}</div>
      )}
      {issues.data && issues.data.length === 0 && (
        <div className="rounded-2xl border border-border bg-surface p-12 text-center">
          <p className="text-[13px] text-muted">
            No {filter === "all" ? "" : filter + " "}ungrouped issues
          </p>
        </div>
      )}
      {issues.data && issues.data.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
          {issues.data.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              selected={selected?.id === issue.id}
              onClick={() => selectIssue(selected?.id === issue.id ? null : issue.id)}
            />
          ))}
        </div>
      )}

      {selected && (
        <IssueDrawer
          projectId={projectId}
          issue={selected}
          onClose={() => selectIssue(null)}
          onToggleSilence={() => handleSilenceToggle(selected)}
          onViewIncident={(incidentId) => openItem(incidentId, "incidents")}
          onOpenEvent={(t) => setEventTarget(t)}
          silenceUpdating={silence.isPending || unsilence.isPending}
        />
      )}

      {eventTarget?.kind === "trace" && (
        <TraceDrawer
          projectId={projectId}
          traceId={eventTarget.traceId}
          focusSpanId={eventTarget.spanId}
          onClose={() => setEventTarget(null)}
        />
      )}
      {eventTarget?.kind === "log" && (
        <LogDrawer
          log={eventTarget.log}
          onClose={() => setEventTarget(null)}
          onOpenTrace={(traceId) =>
            setEventTarget({
              kind: "trace",
              traceId,
              spanId: eventTarget.log.span_id || undefined,
            })
          }
        />
      )}
    </div>
  );
}

export function IssueRow({
  issue,
  selected,
  onClick,
}: {
  issue: Issue;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full px-4 py-3 text-left transition-colors hover:bg-surface-2 ${selected ? "bg-surface-2" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <KindChip issue={issue} />
            {issue.silencedAt && <Chip tone="neutral">silenced</Chip>}
            <GroupingChip state={issue.groupingState} />
            <span className="font-mono text-[11px] text-muted">{issue.exceptionType}</span>
            <ServiceEnv service={issue.service} environment={issueEnvironment(issue)} />
          </div>
          <p className="truncate text-[13px] font-medium text-fg">{issue.title}</p>
          {issue.message && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{issue.message}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[11px] tabular-nums text-muted">
            {fmtRelative(issue.lastSeen)}
          </div>
          <div className="mt-1 font-mono text-[11px] tabular-nums text-subtle">
            {fmtCount(issue.eventCount)} event{issue.eventCount !== 1 ? "s" : ""}
          </div>
        </div>
      </div>
    </button>
  );
}

type IssueDetailProps = {
  projectId?: string;
  issue: Issue;
  onClose: () => void;
  onToggleSilence?: () => void;
  onViewIncident?: (incidentId: string) => void;
  onOpenEvent?: (target: NonNullable<EventTarget>) => void;
  silenceUpdating?: boolean;
};

export function IssueDrawer(props: IssueDetailProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--impersonation-h,0px)] z-50">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={props.onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[720px] flex-col border-l border-border bg-bg shadow-2xl">
        <div className="flex-1 overflow-y-auto">
          <IssueDetailContent {...props} />
        </div>
      </aside>
    </div>
  );
}

export function IssueDetail(props: IssueDetailProps) {
  return (
    <div className="border border-border">
      <IssueDetailContent {...props} />
    </div>
  );
}

function IssueDetailContent({
  projectId,
  issue,
  onClose,
  onToggleSilence,
  onViewIncident,
  onOpenEvent,
  silenceUpdating,
}: IssueDetailProps) {
  const silenced = Boolean(issue.silencedAt);
  const eventTarget = onOpenEvent ? eventTargetFromIssue(issue) : null;
  return (
    <div className="space-y-8 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <KindChip issue={issue} />
          <h2 className="truncate text-[15px] font-semibold leading-snug text-fg">{issue.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <FeedbackTrigger kind="issue" refId={issue.id} projectId={projectId} />
          <button
            onClick={onClose}
            className="text-muted transition-colors hover:text-fg"
            aria-label="close"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {!issue.topFrame && (
            <>
              <span className="font-mono text-[11px] text-muted">{issue.exceptionType}</span>
              <KindChip issue={issue} />
            </>
          )}
          {silenced && <Chip tone="neutral">silenced</Chip>}
          <GroupingChip state={issue.groupingState} />
        </div>
        {issue.topFrame && (
          <div className="space-y-0.5">
            <SectionHeader>Top frame</SectionHeader>
            <p className="font-mono text-[12px] text-muted">{issue.topFrame}</p>
          </div>
        )}
      </div>

      {issue.message && (
        <div className="space-y-3">
          <SectionHeading>Error body</SectionHeading>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-fg">
            {issue.message}
          </pre>
        </div>
      )}

      {issue.symbolication && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <SectionHeading>Original stack</SectionHeading>
            <span className="font-mono text-[10px] text-subtle">
              {issue.symbolication.artifact.platform} - {issue.symbolication.artifact.release}
            </span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-fg">
            {issue.symbolication.stacktrace}
          </pre>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <MetaField label="Service" value={issue.service ?? "—"} />
        <MetaField label="Environment" value={issueEnvironment(issue) ?? "—"} />
        <MetaField label="Events" value={fmtCount(issue.eventCount)} />
        <MetaField label="First seen" value={fmtRelative(issue.firstSeen)} />
        <MetaField label="Last seen" value={fmtRelative(issue.lastSeen)} />
      </div>

      {projectId && (
        <IssueIncidentLink
          projectId={projectId}
          issueId={issue.id}
          groupingState={issue.groupingState}
          groupingReason={issue.groupingReason}
          onViewIncident={onViewIncident}
        />
      )}

      <div className="flex flex-col gap-2">
        {eventTarget && (
          <Btn
            variant="primary"
            size="sm"
            onClick={() => onOpenEvent?.(eventTarget)}
            className="w-full justify-center"
          >
            {eventTarget.kind === "trace" ? "View trace" : "View log event"}
          </Btn>
        )}
        {onToggleSilence && (
          <Btn
            variant="ghost"
            size="sm"
            onClick={onToggleSilence}
            loading={silenceUpdating}
            className="w-full justify-center"
          >
            {silenced ? "Unsilence" : "Silence & tombstone"}
          </Btn>
        )}
      </div>
    </div>
  );
}

function IssueIncidentLink({
  projectId,
  issueId,
  groupingState,
  groupingReason,
  onViewIncident,
}: {
  projectId: string;
  issueId: string;
  groupingState: Issue["groupingState"];
  groupingReason: string | null;
  onViewIncident?: (incidentId: string) => void;
}) {
  const q = useIssueAgentRun(projectId, issueId);
  const incident = q.data?.incident ?? null;
  const linkState = getIssueIncidentLinkState({
    groupingState,
    incident,
    isLoading: q.isLoading,
  });

  if (linkState === "pending") {
    return (
      <div className="space-y-3">
        <SectionHeading>Incident</SectionHeading>
        <p className="text-[12px] text-muted">Analysing — grouping in progress.</p>
      </div>
    );
  }
  if (linkState === "failed") {
    return (
      <div className="space-y-3">
        <SectionHeading>Incident</SectionHeading>
        <p className="text-[12px] text-danger">Grouping analysis failed.</p>
      </div>
    );
  }
  // grouped or standalone — both can have a dedicated incident; standalone
  // just means the issue was not bundled together with other issues.
  if (linkState === "loading") {
    return (
      <div className="space-y-3">
        <SectionHeading>Incident</SectionHeading>
        <p className="text-[12px] text-muted">loading…</p>
      </div>
    );
  }
  if (!incident) {
    return (
      <div className="space-y-3">
        <SectionHeading>Incident</SectionHeading>
        <p className="text-[12px] text-muted">
          {groupingState === "standalone"
            ? "Standalone — not bundled with other issues."
            : "loading…"}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <SectionHeading>Incident</SectionHeading>
      <button
        onClick={() => onViewIncident?.(incident.id)}
        className="block w-full rounded-sm border border-border bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-surface-3"
      >
        <div className="mb-1 flex items-center gap-2">
          <StatusChip status={incident.status} />
          {groupingState === "standalone" && (
            <span className="text-[11px] text-subtle">standalone</span>
          )}
        </div>
        <p className="text-[12px] leading-snug text-fg">{incident.title}</p>
        {groupingReason && <p className="mt-1 text-[11px] italic text-subtle">{groupingReason}</p>}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Incidents tab
// ---------------------------------------------------------------------------

type IncidentGroup = { key: string; label: string; items: IncidentListItem[] };

// Severity buckets in descending order; `null` severity sorts last. Within each
// bucket rows are ordered newest-seen first. Incidents with a pending recovery
// proposal are split off into a trailing "Recovery detected" group regardless
// of severity.
function groupIncidents(rows: IncidentListItem[]): IncidentGroup[] {
  const byLastSeenDesc = (a: IncidentListItem, b: IncidentListItem) =>
    b.incident.lastSeen.localeCompare(a.incident.lastSeen);

  const recovering = rows.filter((r) => r.pendingResolutionProposal != null);
  const active = rows.filter((r) => r.pendingResolutionProposal == null);

  const severityOrder: { key: string; label: string; severity: IncidentSeverity | null }[] = [
    { key: "SEV-1", label: "SEV-1", severity: "SEV-1" },
    { key: "SEV-2", label: "SEV-2", severity: "SEV-2" },
    { key: "SEV-3", label: "SEV-3", severity: "SEV-3" },
    { key: "unset", label: "Unset severity", severity: null },
  ];

  const groups: IncidentGroup[] = [];
  for (const bucket of severityOrder) {
    const items = active
      .filter((r) => r.incident.severity === bucket.severity)
      .sort(byLastSeenDesc);
    if (items.length > 0) {
      groups.push({ key: bucket.key, label: bucket.label, items });
    }
  }

  if (recovering.length > 0) {
    groups.push({
      key: "recovery",
      label: "Recovery detected",
      items: recovering.sort(byLastSeenDesc),
    });
  }

  return groups;
}

function IncidentsTab({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<IncidentStatus>("open");
  const { id: selectedId, openItem, closeItem } = useNav();
  const incidents = useIncidents(projectId, status);

  // Group incidents by severity (most severe first), newest-seen first within
  // each group. Incidents where the autorecovery agent has detected recovery
  // (a pending resolution proposal) are pulled out into a trailing group.
  const groups = useMemo(() => groupIncidents(incidents.data ?? []), [incidents.data]);

  const tabs: { id: IncidentStatus; label: string }[] = [
    { id: "open", label: "Open" },
    { id: "resolved", label: "Resolved" },
    { id: "autoresolved_noise", label: "Noise" },
    { id: "all", label: "All" },
  ];

  function selectIncident(id: string | null) {
    if (id == null) closeItem();
    else openItem(id, "incidents");
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setStatus(t.id);
                selectIncident(null);
              }}
              className={
                status === t.id
                  ? "rounded-lg bg-surface-2 px-3 py-1.5 text-[13px] font-medium tracking-tight text-fg"
                  : "rounded-lg px-3 py-1.5 text-[13px] font-medium tracking-tight text-muted hover:text-fg"
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        {incidents.data && (
          <span className="text-[12px] text-muted">
            {incidents.data.length} incident{incidents.data.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {incidents.isLoading && <div className="text-[13px] text-muted">Loading…</div>}
      {incidents.error && (
        <div className="text-[13px] text-danger">Failed to load: {String(incidents.error)}</div>
      )}
      {incidents.data && incidents.data.length === 0 && (
        <div className="rounded-2xl border border-border bg-surface p-12 text-center">
          <p className="text-[13px] text-muted">
            No {status === "all" ? "" : status + " "}incidents
          </p>
        </div>
      )}
      {incidents.data && incidents.data.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key}>
              <h3 className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                {group.label}
              </h3>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                {group.items.map((row) => (
                  <IncidentRow
                    key={row.incident.id}
                    row={row}
                    selected={selectedId === row.incident.id}
                    onClick={() =>
                      selectIncident(selectedId === row.incident.id ? null : row.incident.id)
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {selectedId && (
        <IncidentDrawer
          projectId={projectId}
          incidentId={selectedId}
          onClose={() => selectIncident(null)}
          onViewIssue={(issueId) => openItem(issueId, "issues")}
        />
      )}
    </div>
  );
}

export function IncidentRow({
  row,
  selected,
  onClick,
}: {
  row: IncidentListItem;
  selected: boolean;
  onClick: () => void;
}) {
  const { incident, pendingResolutionProposal } = row;
  const [rowRef, nearViewport] = useNearViewport<HTMLButtonElement>();
  const hasInlineActivity = row.buckets !== undefined;
  const stats = useIncidentStats(incident.projectId, incident.id, {
    enabled: nearViewport && !hasInlineActivity,
  });
  const activity = hasInlineActivity
    ? {
        buckets: row.buckets ?? [],
        impactedUsers: row.impactedUsers ?? 0,
        impactedUsersAvailable: row.impactedUsersAvailable ?? false,
        impactedUsersCapped: row.impactedUsersCapped ?? false,
      }
    : stats.data
      ? {
          buckets: stats.data.buckets,
          impactedUsers: stats.data.impactedUsers,
          impactedUsersAvailable: stats.data.impactedUsersAvailable,
          impactedUsersCapped: false,
        }
      : null;
  return (
    <button
      type="button"
      ref={rowRef}
      onClick={onClick}
      className={`w-full px-4 py-3 text-left transition-colors hover:bg-surface-2 ${selected ? "bg-surface-2" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            {incident.severity && <SeverityChip severity={incident.severity} />}
            <ServiceEnv service={incident.service} environment={incident.environment} />
            {pendingResolutionProposal && <RecoveryDetectedBadge />}
          </div>
          <p className="truncate text-[13px] font-medium text-fg">{incident.title}</p>
          {incident.codename && (
            <p className="mt-0.5 font-mono text-[11px] text-subtle">{incident.codename}</p>
          )}
        </div>
        <div className="hidden shrink-0 self-center sm:block">
          <LazyRowSparkline activity={activity} error={!!stats.error} />
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[11px] tabular-nums text-muted">
            {fmtRelative(incident.lastSeen)}
          </div>
          <LazyRowUsersImpacted activity={activity} error={!!stats.error} />
        </div>
      </div>
    </button>
  );
}

function IncidentDrawer({
  projectId,
  incidentId,
  onClose,
  onViewIssue,
}: {
  projectId: string;
  incidentId: string;
  onClose: () => void;
  onViewIssue: (issueId: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--impersonation-h,0px)] z-50">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[720px] flex-col border-l border-border bg-bg shadow-2xl">
        <div className="flex-1 overflow-y-auto">
          <IncidentDrawerBody
            projectId={projectId}
            incidentId={incidentId}
            onClose={onClose}
            onViewIssue={onViewIssue}
          />
        </div>
      </aside>
    </div>
  );
}

function IncidentDrawerBody({
  projectId,
  incidentId,
  onClose,
  onViewIssue,
}: {
  projectId: string;
  incidentId: string;
  onClose: () => void;
  onViewIssue: (issueId: string) => void;
}) {
  const q = useIncident(projectId, incidentId);
  const updateIncident = useUpdateIncident(projectId);
  const restartAgentRun = useRestartAgentRun(projectId);
  const retryPrDelivery = useRetryPrDelivery(projectId);
  const decideProposal = useDecideResolutionProposal(projectId);

  if (q.isLoading) {
    return (
      <div className="p-4 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
        loading…
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="p-4 font-mono text-[11px] text-danger">
        failed: {String(q.error ?? "no data")}
      </div>
    );
  }
  const { incident, issues, agentRun, agentRuns, timeline, alertEpisodes } = q.data;
  const statusAction = getIncidentStatusAction(incident.status);

  function handleToggleStatus() {
    updateIncident.mutate({
      incidentId: incident.id,
      status: statusAction.targetStatus,
    });
  }

  function handleRestartAgentRun() {
    restartAgentRun.mutate(incident.id);
  }

  function handleRetryPrDelivery() {
    retryPrDelivery.mutate(incident.id);
  }

  return (
    <IncidentDetailContent
      incident={incident}
      issues={issues}
      agentRun={agentRun}
      agentRuns={agentRuns}
      alertEpisodes={alertEpisodes}
      pendingResolutionProposal={q.data.pendingResolutionProposal ?? null}
      events={timeline}
      eventsLoading={false}
      eventsError={null}
      onClose={onClose}
      onViewIssue={onViewIssue}
      onToggleStatus={handleToggleStatus}
      onRestartAgentRun={handleRestartAgentRun}
      onRetryPrDelivery={handleRetryPrDelivery}
      onDecideProposal={(proposalId, decision) =>
        decideProposal.mutate({ incidentId: incident.id, proposalId, decision })
      }
      updateIncidentError={updateIncident.error}
      decidingProposal={decideProposal.isPending}
      updatingIncident={updateIncident.isPending}
      restartingAgentRun={restartAgentRun.isPending}
      retryingPrDelivery={retryPrDelivery.isPending}
    />
  );
}

function buildAgentRunPrompt({
  incident,
  issues,
  agentRun,
}: {
  incident: Incident;
  issues: Issue[];
  agentRun: AgentRun | null;
}): string {
  const lines: string[] = [];
  lines.push(
    "You're investigating a production incident surfaced by Superlog. Use the Superlog MCP server to pull traces, logs, and metrics — don't guess from this prompt alone.",
    "",
    "If the Superlog MCP isn't connected yet, add it first:",
    "  claude mcp add --transport http superlog https://api.superlog.sh/mcp",
    "(Codex / Cursor have equivalent commands — see the Superlog dashboard.)",
    "",
    "## Incident",
    `- Title: ${incident.title}`,
    `- Codename: ${incident.codename}`,
    `- Severity: ${incident.severity ?? "unset"}`,
    `- Status: ${incident.status}`,
    `- Service: ${incident.service ?? "unknown"}`,
    `- Environment: ${incident.environment ?? "unknown"}`,
    `- First seen: ${incident.firstSeen}`,
    `- Last seen: ${incident.lastSeen}`,
    `- Incident ID: ${incident.id}`,
    `- Project ID: ${incident.projectId}`,
  );

  lines.push("", `## Issues in this incident (${issues.length})`);
  if (issues.length === 0) {
    lines.push("(none)");
  } else {
    issues.forEach((issue, i) => {
      lines.push(
        `${i + 1}. ${issue.exceptionType}: ${issue.title}`,
        `   - Service: ${issue.service ?? "unknown"}`,
        `   - Environment: ${issueEnvironment(issue) ?? "unknown"}`,
        `   - Message: ${issue.message ?? "(none)"}`,
        `   - Top frame: ${issue.topFrame ?? "(none)"}`,
        `   - Symbolicated top frame: ${formatSymbolicatedTopFrame(issue) ?? "(none)"}`,
        `   - Event count: ${issue.eventCount}`,
        `   - First/last seen: ${issue.firstSeen} → ${issue.lastSeen}`,
        `   - Issue ID: ${issue.id}`,
      );
    });
  }

  const result = agentRun?.result ?? null;
  if (agentRun || result) {
    lines.push("", "## Prior Superlog agent run");
    if (agentRun) {
      lines.push(`- State: ${agentRun.state}`);
      if (agentRun.selectedRepoFullName) {
        lines.push(`- Repo: ${agentRun.selectedRepoFullName}`);
      }
      if (agentRun.selectedBaseBranch) {
        lines.push(`- Base branch: ${agentRun.selectedBaseBranch}`);
      }
      if (agentRun.failureReason) {
        lines.push(`- Failure: ${agentRun.failureReason}`);
      }
    }
    if (result?.summary) {
      lines.push("", "### Summary", result.summary);
    }
    if (result && isConfidenceField(result.rootCause)) {
      lines.push(
        "",
        `### Root cause (confidence ${result.rootCause.confidence})`,
        result.rootCause.text,
      );
    }
    if (result && isConfidenceField(result.estimatedImpact)) {
      lines.push(
        "",
        `### Estimated impact (confidence ${result.estimatedImpact.confidence})`,
        result.estimatedImpact.text,
      );
    }
    if (result?.pr?.url) {
      lines.push("", `### Existing PR`, result.pr.url);
    }
  }

  lines.push(
    "",
    "## Task",
    `1. Query the Superlog MCP for traces, logs, and metrics around \`${incident.lastSeen}\` for service \`${incident.service ?? "(see above)"}\` and project \`${incident.projectId}\`. Pull representative samples for each issue ID above.`,
    "2. If a sample includes a `session.id` attribute, use it to query preceding traces and logs from the same user/app session before focusing only on the failing trace or log line.",
    "3. Identify the root cause. Cite specific trace IDs, span attributes, log lines, and (if you have repo access) the offending file + line.",
    "4. Propose a fix. If a prior agent run is shown above, treat it as a hypothesis — verify or refute it against the data rather than restating it.",
    "5. Reply with: a short root-cause statement, the supporting evidence (trace/log/metric references), and the proposed change.",
  );

  return lines.join("\n");
}

function formatSymbolicatedTopFrame(issue: Issue): string | null {
  const frame = issue.symbolication?.frames[0];
  if (!frame) return null;
  const fn = frame.functionName ? `${frame.functionName}@` : "";
  return `${fn}${frame.source}:${frame.line}:${frame.column}`;
}

function CopyAgentPromptButton({
  incident,
  issues,
  agentRun,
}: {
  incident: Incident;
  issues: Issue[];
  agentRun: AgentRun | null;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  async function handleCopy() {
    const text = buildAgentRunPrompt({ incident, issues, agentRun });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(false);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(true);
      setTimeout(() => setError(false), 1600);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-fg transition-colors hover:border-border-strong"
      title="Copy a ready-to-paste prompt that briefs an agent on this incident and points it at the Superlog MCP."
    >
      <span aria-hidden>{error ? "⚠" : copied ? "✓" : "📋"}</span>
      {error ? "Copy failed" : copied ? "Copied" : "Copy agent prompt"}
    </button>
  );
}

function IncidentActivityPanel({
  projectId,
  incidentId,
}: {
  projectId: string;
  incidentId: string;
}) {
  const stats = useIncidentStats(projectId, incidentId);
  return (
    <div className="space-y-3">
      <SectionHeading>Recent activity</SectionHeading>
      <div className="grid grid-cols-[1fr_auto] gap-4 rounded-md border border-border bg-surface p-3">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Events · last {stats.data?.windowDays ?? 14}d
          </div>
          {stats.isLoading ? (
            <ActivitySparklineSkeleton />
          ) : stats.error || !stats.data ? (
            <div className="h-[44px] text-[12px] text-danger">Failed to load activity</div>
          ) : (
            <ActivitySparkline buckets={stats.data.buckets} />
          )}
          {stats.data && (
            <div className="font-mono text-[11px] text-muted">
              {stats.data.totalEvents.toLocaleString()} events
            </div>
          )}
        </div>
        <div className="flex min-w-[140px] flex-col justify-between gap-1 border-l border-border pl-4">
          <div className="text-[11px] uppercase tracking-wide text-muted">Users impacted</div>
          <ImpactedUsersValue stats={stats.data} loading={stats.isLoading} />
        </div>
      </div>
    </div>
  );
}

function ImpactedUsersValue({
  stats,
  loading,
}: {
  stats: IncidentStats | undefined;
  loading: boolean;
}) {
  if (loading) return <ImpactedUsersSkeleton />;
  if (!stats) return <div className="text-[12px] text-muted">—</div>;
  if (!stats.impactedUsersAvailable) {
    return (
      <div className="space-y-0.5">
        <div className="font-mono text-[16px] text-muted">—</div>
        <div className="text-[10px] leading-snug text-muted">
          Set <code className="font-mono">user.id</code> on spans to populate this.
        </div>
      </div>
    );
  }
  return (
    <div className="font-mono text-[20px] font-semibold text-fg">
      {stats.impactedUsers.toLocaleString()}
    </div>
  );
}

type IncidentRowActivity = {
  buckets: { day: string; count: number }[];
  impactedUsers: number;
  impactedUsersAvailable: boolean;
  impactedUsersCapped: boolean;
};

function LazyRowSparkline({
  activity,
  error,
}: {
  activity: IncidentRowActivity | null;
  error: boolean;
}) {
  if (activity) {
    return activity.buckets.length > 0 ? (
      <RowSparkline buckets={activity.buckets} />
    ) : (
      <div className="h-10 w-[112px]" aria-hidden />
    );
  }
  if (!error) return <RowSparklineSkeleton />;
  return <div className="h-10 w-[112px]" aria-hidden />;
}

function LazyRowUsersImpacted({
  activity,
  error,
}: {
  activity: IncidentRowActivity | null;
  error: boolean;
}) {
  if (activity) {
    return (
      <RowUsersImpacted
        count={activity.impactedUsers}
        available={activity.impactedUsersAvailable}
        capped={activity.impactedUsersCapped}
      />
    );
  }
  if (!error) return <RowUsersSkeleton />;
  return (
    <div className="mt-1 font-mono text-[11px] tabular-nums text-subtle" title="Activity failed">
      — users
    </div>
  );
}

function RowSparklineSkeleton() {
  return (
    <div className="flex h-10 w-[112px] items-end gap-[2px]" aria-label="Loading activity">
      {[28, 52, 36, 68, 44, 74, 58, 34, 62, 48, 78, 54, 40, 64].map((height, idx) => (
        <span
          key={`${height}-${idx}`}
          className="flex-1 rounded-[1px] bg-surface-2"
          style={{ height: `${height}%` }}
        />
      ))}
    </div>
  );
}

function RowUsersSkeleton() {
  return (
    <div
      className="ml-auto mt-1 h-[14px] w-14 rounded-sm bg-surface-2"
      aria-label="Loading users"
    />
  );
}

function ActivitySparklineSkeleton() {
  return (
    <div className="flex h-[60px] w-full items-end gap-[1.5%]" aria-label="Loading activity">
      {[32, 48, 40, 62, 36, 76, 54, 44, 68, 50, 82, 58, 42, 66].map((height, idx) => (
        <span
          key={`${height}-${idx}`}
          className="rounded-sm bg-surface-2"
          style={{
            width: `${(100 - 1.5 * 13) / 14}%`,
            height: `${height}%`,
          }}
        />
      ))}
    </div>
  );
}

function ImpactedUsersSkeleton() {
  return <div className="h-7 w-20 rounded-sm bg-surface-2" aria-label="Loading impacted users" />;
}

function RowUsersImpacted({
  count,
  available,
  capped,
}: {
  count: number;
  available: boolean;
  capped: boolean;
}) {
  if (!available) {
    // Empty signal: the incident's events had no `user.id`, so we can't say.
    return (
      <div
        className="mt-1 font-mono text-[11px] tabular-nums text-subtle"
        title="No user.id attribute on this incident's events"
      >
        — users
      </div>
    );
  }
  const label = capped ? `${count.toLocaleString()}+` : count.toLocaleString();
  return (
    <div className="mt-1 font-mono text-[11px] tabular-nums text-subtle">
      {label} user{count === 1 && !capped ? "" : "s"}
    </div>
  );
}

function RowSparkline({ buckets }: { buckets: { day: string; count: number }[] }) {
  if (buckets.length === 0) return null;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  // Tiebreaker = earliest matching day so the value mark stays put across renders.
  const peakIdx = max > 0 ? buckets.findIndex((b) => b.count === max) : -1;
  return (
    // Outer wrapper is taller than the bar area so the peak marker has room to
    // sit above the bars without scaling them down. Bars are pinned to the
    // bottom; the marker is positioned via bottom:100% on the peak bar so it
    // always rests at the bar's top edge.
    <div className="relative h-10 w-[112px]" role="img" aria-label="Last 14 days activity">
      <div className="absolute inset-x-0 bottom-0 flex h-6 items-end gap-[2px]">
        {buckets.map((b, idx) => {
          const heightPct = (b.count / max) * 100;
          const isPeak = idx === peakIdx;
          return (
            <div
              key={b.day}
              title={`${b.day}: ${b.count.toLocaleString()} events`}
              className="relative flex-1 rounded-[1px]"
              style={{
                height: `max(1px, ${heightPct}%)`,
                backgroundColor: "var(--color-accent)",
                opacity: b.count === 0 ? 0.18 : isPeak ? 1 : 0.5,
              }}
            >
              {isPeak && <PeakMarker value={b.count} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "Value mark" anchored to the top of the peak bar. bottom:100% means the label
// rests on the bar regardless of bar height (works for both tall and short peaks).
function PeakMarker({ value }: { value: number }) {
  return (
    <span
      className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 whitespace-nowrap pb-0.5 font-mono text-[9px] leading-none tabular-nums"
      style={{ color: "var(--color-accent)" }}
      aria-hidden
    >
      {value.toLocaleString()}
    </span>
  );
}

function ActivitySparkline({ buckets }: { buckets: { day: string; count: number }[] }) {
  if (buckets.length === 0) {
    return <div className="h-[44px] text-[12px] text-muted">No events</div>;
  }
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const peakIdx = max > 0 ? buckets.findIndex((b) => b.count === max) : -1;
  const barCount = buckets.length;
  // Use percentage-based widths so it fills whatever the container gives us.
  const gapPct = 1.5;
  const barPct = (100 - gapPct * (barCount - 1)) / barCount;
  return (
    <div
      className="relative h-[60px] w-full"
      role="img"
      aria-label={`Daily event counts for the last ${barCount} days`}
    >
      <div className="absolute inset-x-0 bottom-0 flex h-[44px] items-end gap-[1.5%]">
        {buckets.map((b, idx) => {
          const heightPct = (b.count / max) * 100;
          const isPeak = idx === peakIdx;
          return (
            <div
              key={b.day}
              title={`${b.day}: ${b.count.toLocaleString()} events`}
              className="relative rounded-sm transition-opacity hover:opacity-100"
              // Tailwind's color-modifier (`bg-accent/70`) doesn't compile to a
              // visible rgba in this project's config, so we paint the bar with
              // an inline var() reference and tweak opacity to dim empty days.
              style={{
                width: `${barPct}%`,
                // 2px minimum so empty days still show a faint baseline.
                height: `max(2px, ${heightPct}%)`,
                backgroundColor: "var(--color-accent)",
                opacity: b.count === 0 ? 0.22 : isPeak ? 1 : 0.7,
              }}
            >
              {isPeak && <PeakMarker value={b.count} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "Triggered by" back-link: an alert-raised incident points back at the
// episode(s) of the alert that opened it, so you can hop from the incident to
// the alert rule and its full activation history. Rendered with the same tile
// markup as the issues list below it.
function TriggeredByAlertEpisodes({ episodes }: { episodes: IncidentAlertEpisode[] }) {
  return (
    <ul className="divide-y divide-border border border-border">
      {episodes.map((ep) => {
        const firing = ep.state === "firing";
        return (
          <li key={ep.id} className="px-3 py-2">
            <Link
              to={`/alerts/${ep.alertId}`}
              className="block w-full min-w-0 overflow-hidden text-left transition-colors hover:text-muted"
            >
              <div className="mb-0.5 flex items-center gap-2">
                <Chip tone="accent">alert</Chip>
                <span className="font-mono text-[11px] text-muted">Episode #{ep.seq}</span>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${firing ? "bg-danger" : "bg-subtle"}`}
                    aria-hidden
                  />
                  {firing ? "Firing" : "Resolved"}
                </span>
              </div>
              <p className="truncate text-[12px] text-fg">
                {ep.alertName}
                {ep.groupKey ? ` · ${ep.groupKey}` : ""}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function IncidentDetailContent({
  incident,
  issues,
  agentRun,
  agentRuns = [],
  alertEpisodes = [],
  pendingResolutionProposal,
  events,
  eventsLoading,
  eventsError,
  onClose,
  onViewIssue,
  onToggleStatus,
  onRestartAgentRun,
  onRetryPrDelivery,
  onDecideProposal,
  updateIncidentError = null,
  decidingProposal,
  updatingIncident,
  restartingAgentRun = false,
  retryingPrDelivery = false,
}: {
  incident: Incident;
  issues: Issue[];
  agentRun: AgentRun | null;
  agentRuns?: AgentRun[];
  alertEpisodes?: IncidentAlertEpisode[];
  pendingResolutionProposal?: PendingResolutionProposal | null;
  events: IncidentEvent[];
  eventsLoading: boolean;
  eventsError: Error | null;
  onClose: () => void;
  onViewIssue: (issueId: string) => void;
  onToggleStatus: () => void;
  onRestartAgentRun?: () => void;
  onRetryPrDelivery?: () => void;
  onDecideProposal?: (proposalId: string, decision: "confirm" | "dismiss") => void;
  updateIncidentError?: Error | null;
  decidingProposal?: boolean;
  updatingIncident: boolean;
  restartingAgentRun?: boolean;
  retryingPrDelivery?: boolean;
}) {
  const [detailTab, setDetailTab] = useState<"incident" | "pr">("incident");
  const statusAction = getIncidentStatusAction(incident.status);

  return (
    <div className="space-y-8 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusChip status={incident.status} pendingResolution={!!pendingResolutionProposal} />
            {incident.severity && <SeverityChip severity={incident.severity} />}
            {incident.codename && (
              <span className="font-mono text-[11px] text-muted">{incident.codename}</span>
            )}
          </div>
          <h2 className="text-[15px] font-semibold leading-snug text-fg">{incident.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <CopyAgentPromptButton incident={incident} issues={issues} agentRun={agentRun} />
          <FeedbackTrigger kind="incident" refId={incident.id} projectId={incident.projectId} />
          <button
            onClick={onClose}
            className="text-muted transition-colors hover:text-fg"
            aria-label="close"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <IncidentDetailTabs active={detailTab} onChange={setDetailTab} />

      {detailTab === "incident" ? (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <MetaInline label="Service" value={incident.service ?? "—"} />
              <MetaInline label="Environment" value={incident.environment ?? "—"} />
            </div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <MetaInline label="First seen" value={fmtRelative(incident.firstSeen)} />
              <MetaInline label="Last seen" value={fmtRelative(incident.lastSeen)} />
            </div>
          </div>

          {alertEpisodes.length > 0 && (
            <div className="space-y-3">
              <SectionHeading>Triggered by</SectionHeading>
              <TriggeredByAlertEpisodes episodes={alertEpisodes} />
            </div>
          )}

          <IncidentActivityPanel projectId={incident.projectId} incidentId={incident.id} />

          {pendingResolutionProposal && onDecideProposal && (
            <ResolutionProposalBanner
              proposal={pendingResolutionProposal}
              onConfirm={() => onDecideProposal(pendingResolutionProposal.id, "confirm")}
              onDismiss={() => onDecideProposal(pendingResolutionProposal.id, "dismiss")}
              deciding={!!decidingProposal}
            />
          )}

          <div className="space-y-3">
            <SectionHeading>Issues in this incident</SectionHeading>
            {issues.length === 0 ? (
              <p className="text-[12px] text-muted">none</p>
            ) : (
              <IssueList issues={issues} onViewIssue={onViewIssue} />
            )}
          </div>

          <AgentRunView
            incident={incident}
            agentRun={agentRun}
            agentRuns={agentRuns}
            events={events}
            eventsError={eventsError}
            eventsLoading={eventsLoading}
            onRestart={onRestartAgentRun}
            onRetryPrDelivery={onRetryPrDelivery}
            restarting={restartingAgentRun}
            retryingPrDelivery={retryingPrDelivery}
          />

          <div className="mt-8 border-t border-border pt-6">
            <IncidentTimeline
              events={events}
              eventsError={eventsError}
              eventsLoading={eventsLoading}
            />
          </div>

          <Btn
            variant={statusAction.variant}
            size="sm"
            onClick={onToggleStatus}
            loading={updatingIncident}
            className="w-full justify-center"
          >
            {statusAction.label}
          </Btn>
          {updateIncidentError && (
            <p className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              Status update failed: {String(updateIncidentError)}
            </p>
          )}
        </>
      ) : (
        <IncidentPullRequestPanel projectId={incident.projectId} incidentId={incident.id} />
      )}
    </div>
  );
}

function IncidentDetailTabs({
  active,
  onChange,
}: {
  active: "incident" | "pr";
  onChange: (tab: "incident" | "pr") => void;
}) {
  const tabs: { id: "incident" | "pr"; label: string }[] = [
    { id: "incident", label: "Incident" },
    { id: "pr", label: "PR" },
  ];
  return (
    <div className="-mx-4 border-b border-border px-4">
      <div className="flex gap-9">
        {tabs.map((tab) => {
          const selected = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={`relative h-11 text-[14px] font-medium transition-colors ${
                selected ? "text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {tab.label}
              {selected && (
                <span className="absolute inset-x-0 bottom-0 h-[3px] bg-fg" aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function IncidentPullRequestPanel({
  projectId,
  incidentId,
}: {
  projectId: string;
  incidentId: string;
}) {
  const prs = useIncidentPullRequests(projectId, incidentId);
  const mergePr = useMergeIncidentPullRequest(projectId, incidentId);
  const [selectedPrId, setSelectedPrId] = useState<string | null>(null);

  const selectedPr = prs.data?.find((pr) => pr.id === selectedPrId) ?? prs.data?.[0] ?? null;

  useEffect(() => {
    if (!prs.data?.length) {
      setSelectedPrId(null);
      return;
    }
    if (!selectedPrId || !prs.data.some((pr) => pr.id === selectedPrId)) {
      setSelectedPrId(prs.data[0]!.id);
    }
  }, [prs.data, selectedPrId]);

  if (prs.isLoading) {
    return <p className="text-[12px] text-muted">Loading PR…</p>;
  }
  if (prs.error) {
    return <p className="text-[12px] text-danger">Failed to load PR: {String(prs.error)}</p>;
  }
  if (!prs.data || prs.data.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface p-4">
        <SectionHeading>Pull request</SectionHeading>
        <p className="mt-2 text-[12px] text-muted">No PR has been opened for this incident.</p>
      </div>
    );
  }
  if (!selectedPr) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <SectionHeading>Pull request</SectionHeading>
          <a
            href={selectedPr.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-[13px] font-medium text-fg hover:underline"
          >
            {selectedPr.repoFullName} #{selectedPr.prNumber}
          </a>
          <p className="truncate text-[12px] text-muted">
            {selectedPr.title ?? selectedPr.branchName} into {selectedPr.baseBranch}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={selectedPr.state === "merged" ? "success" : "neutral"} dot>
            {selectedPr.state}
          </Chip>
          {selectedPr.state === "open" && (
            <Btn
              size="sm"
              variant="primary"
              loading={mergePr.isPending}
              onClick={() => mergePr.mutate({ prId: selectedPr.id })}
            >
              Merge PR
            </Btn>
          )}
        </div>
      </div>

      {prs.data.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {prs.data.map((pr) => (
            <button
              key={pr.id}
              type="button"
              onClick={() => setSelectedPrId(pr.id)}
              className={`shrink-0 rounded-sm border px-2.5 py-1 text-[12px] ${
                selectedPr.id === pr.id
                  ? "border-border-strong bg-surface-2 text-fg"
                  : "border-border text-muted hover:text-fg"
              }`}
            >
              #{pr.prNumber}
            </button>
          ))}
        </div>
      )}

      {mergePr.error && (
        <p className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          Merge failed: {String(mergePr.error)}
        </p>
      )}

      {!selectedPr.patch ? (
        <div className="rounded-md border border-border bg-surface p-4">
          <p className="text-[12px] text-muted">No patch body was recorded for this PR.</p>
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="min-h-[520px] rounded-md border border-border bg-surface p-4 text-[12px] text-muted">
              Loading diff…
            </div>
          }
        >
          <IncidentPrDiffView patch={selectedPr.patch} patchKey={selectedPr.id} />
        </Suspense>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentRun rendering (shared)
// ---------------------------------------------------------------------------

// Defensive shape check — agent-emitted result fields are sometimes malformed
// (e.g. a flat string in place of { text, confidence }), and the alternative is
// the whole detail panel crashing on render.
function isConfidenceField(v: unknown): v is { text: string; confidence: number } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { text?: unknown }).text === "string" &&
    typeof (v as { confidence?: unknown }).confidence === "number"
  );
}

export function AgentRunView({
  incident,
  agentRun,
  agentRuns = [],
  events,
  eventsError,
  eventsLoading,
  onRestart,
  onRetryPrDelivery,
  restarting = false,
  retryingPrDelivery = false,
}: {
  incident: Incident;
  agentRun: AgentRun | null;
  agentRuns?: AgentRun[];
  events: IncidentEvent[];
  eventsError: Error | null;
  eventsLoading: boolean;
  onRestart?: () => void;
  onRetryPrDelivery?: () => void;
  restarting?: boolean;
  retryingPrDelivery?: boolean;
}) {
  if (!agentRun) {
    return (
      <div className="space-y-3">
        <SectionHeading>AgentRun</SectionHeading>
        <p className="text-[12px] text-muted">No agent run queued yet.</p>
      </div>
    );
  }
  const result = agentRun.result;
  // Findings now live on the incident — every successful run flattens them
  // there. Fall back to the run's `result` jsonb only when the incident
  // columns are empty (in-flight or pre-backfill rows).
  const summary = incident.agentSummary ?? result?.summary ?? null;
  const resolutionClassification =
    incident.resolutionClassification ?? result?.resolutionClassification ?? null;
  const estimatedImpact =
    incident.estimatedImpactText !== null && incident.estimatedImpactConfidence !== null
      ? { text: incident.estimatedImpactText, confidence: incident.estimatedImpactConfidence }
      : isConfidenceField(result?.estimatedImpact)
        ? result!.estimatedImpact!
        : null;
  const rootCause =
    incident.rootCauseText !== null && incident.rootCauseConfidence !== null
      ? { text: incident.rootCauseText, confidence: incident.rootCauseConfidence }
      : isConfidenceField(result?.rootCause)
        ? result!.rootCause!
        : null;
  const linkCtx: EvidenceLinkContext = {
    repoUrl: agentRun.selectedRepoUrl,
    baseBranch: agentRun.selectedBaseBranch,
    linearTicketUrl: result?.linearTicket?.url ?? null,
    linearTicketId: result?.linearTicket?.id ?? null,
  };
  const retryPrAvailable = canRetryPrDelivery(agentRun);
  return (
    <div className="space-y-6">
      {summary && (
        <div className="space-y-2">
          <SectionHeading>Summary</SectionHeading>
          <Clamp3>
            <p className="text-[12.5px] leading-relaxed text-fg">{summary}</p>
          </Clamp3>
        </div>
      )}
      {resolutionClassification && typeof resolutionClassification === "object" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <SectionHeading>Resolution</SectionHeading>
            <Chip tone="success">{resolutionReasonLabel(resolutionClassification.reason)}</Chip>
          </div>
          <EvidenceMarkdown text={resolutionClassification.evidence} ctx={linkCtx} />
        </div>
      )}
      {estimatedImpact && (
        <CollapsibleEvidenceSection
          title="Estimated impact"
          confidence={estimatedImpact.confidence}
          text={estimatedImpact.text}
          ctx={linkCtx}
          defaultOpen
        />
      )}
      {rootCause && (
        <CollapsibleEvidenceSection
          title="Root cause"
          confidence={rootCause.confidence}
          text={rootCause.text}
          ctx={linkCtx}
          defaultOpen
        />
      )}
      {result?.question && (
        <div className="space-y-2">
          <SectionHeading>Question</SectionHeading>
          <p className="text-[12.5px] leading-relaxed text-fg">{result.question}</p>
        </div>
      )}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <SectionHeading>Agent run</SectionHeading>
          <AgentRunStateChip state={agentRun.state} />
          {retryPrAvailable && onRetryPrDelivery && (
            <Btn
              variant="secondary"
              size="sm"
              onClick={onRetryPrDelivery}
              loading={retryingPrDelivery}
              className="ml-auto"
            >
              Retry PR
            </Btn>
          )}
          {onRestart && (
            <Btn
              variant="secondary"
              size="sm"
              onClick={onRestart}
              loading={restarting}
              className={retryPrAvailable ? "" : "ml-auto"}
            >
              Restart
            </Btn>
          )}
        </div>
        <AgentRunMeta agentRun={agentRun} />
      </div>
      <AgentRunDeliverables agentRun={agentRun} />
      {agentRun.failureReason && (
        <div className="space-y-3">
          <SectionHeading>Failure</SectionHeading>
          <p className="text-[12px] text-danger">{agentRun.failureReason}</p>
        </div>
      )}
      {agentRuns.length > 1 && (
        <div className="space-y-2">
          <SectionHeading>Run history</SectionHeading>
          <ul className="space-y-1 font-mono text-[11px]">
            {agentRuns.map((run, i) => (
              <li key={run.id} className="flex items-center gap-2">
                <span className="text-muted">#{agentRuns.length - i}</span>
                <AgentRunStateChip state={run.state} />
                <span className="text-muted">
                  {run.completedAt
                    ? fmtRelative(run.completedAt)
                    : run.startedAt
                      ? `started ${fmtRelative(run.startedAt)}`
                      : `queued ${fmtRelative(run.createdAt)}`}
                </span>
                {run.failureReason && (
                  <span className="truncate text-danger">{run.failureReason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function canRetryPrDelivery(agentRun: AgentRun): boolean {
  if (agentRun.state !== "failed" || agentRun.failureReason !== "pr_open_failed") return false;
  const pr = agentRun.result?.pr ?? null;
  if (!pr || pr.openStatus !== "pending") return false;
  if (!pr.selectedRepoFullName || !pr.baseBranch) return false;
  return !!(
    (typeof pr.patch === "string" && pr.patch.trim().length > 0) ||
    (typeof pr.patchFileId === "string" && pr.patchFileId.trim().length > 0) ||
    (typeof pr.patchFilePath === "string" && pr.patchFilePath.trim().length > 0)
  );
}

// Banner shown at the top of the incident detail when the autorecovery agent has
// proposed a resolution that nobody's decided on yet. Mirrors the Slack
// thread message — same buttons, same outcomes — so a teammate who lives
// in the dashboard doesn't have to bounce to Slack to act on it.
export function ResolutionProposalBanner({
  proposal,
  onConfirm,
  onDismiss,
  deciding,
}: {
  proposal: PendingResolutionProposal;
  onConfirm: () => void;
  onDismiss: () => void;
  deciding: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-wide">
        <span className="text-success">Recovery detected</span>
        <span aria-hidden className="text-muted">
          ·
        </span>
        <span className="inline-flex items-center gap-1 text-muted">
          <HugeiconsIcon icon={ChartIncreaseIcon} size={12} strokeWidth={2} />
          {proposal.confidence} confidence
        </span>
      </div>
      <p className="mb-2 text-[14px] font-medium leading-snug text-fg">
        {sentenceCase(humanizeReasonCode(proposal.proposedReasonCode))}
      </p>
      <p className="mb-3 text-[13px] leading-relaxed text-muted">{proposal.proposedReasonText}</p>
      <div className="flex items-center justify-end gap-2">
        <Btn variant="ghost" size="sm" onClick={onDismiss} loading={deciding}>
          Dismiss
        </Btn>
        <Btn variant="primary" size="sm" onClick={onConfirm} loading={deciding}>
          Confirm resolution
        </Btn>
      </div>
    </div>
  );
}

// Top-level incident timeline. Lives outside InvestigationView because an
// incident has lifecycle events (manual resolves, autorecovery proposal
// confirmations, recurrence reopens) that aren't tied to any
// investigation — and the view shouldn't disappear just because no agent
// has run yet.
export function IncidentTimeline({
  events,
  eventsError,
  eventsLoading,
}: {
  events: IncidentEvent[];
  eventsError: Error | null;
  eventsLoading: boolean;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading>Timeline</SectionHeading>
      {eventsLoading && <p className="text-[12px] text-muted">loading…</p>}
      {eventsError && <p className="text-[12px] text-danger">failed: {String(eventsError)}</p>}
      {!eventsLoading && !eventsError && events.length === 0 && (
        <p className="text-[12px] text-muted">No activity yet.</p>
      )}
      {events.length > 0 && <TimelineView events={events} />}
    </div>
  );
}

function AgentRunMeta({ agentRun }: { agentRun: AgentRun }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <MetaField label="Repo" value={agentRun.selectedRepoFullName ?? "—"} />
      <MetaField label="Branch" value={agentRun.selectedBaseBranch ?? "—"} />
    </div>
  );
}

function AgentRunDeliverables({ agentRun }: { agentRun: AgentRun }) {
  const result = agentRun.result;
  if (!result) return null;
  const pr = result.pr ?? null;
  const ticket = result.linearTicket ?? null;
  if (!pr && !ticket) return null;
  return (
    <div className="space-y-3">
      <SectionHeading>Deliverables</SectionHeading>
      <div className="flex flex-wrap gap-2">
        {pr && pr.openStatus === "opened" && pr.url && (
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-[12px]">
            <Chip tone="success" dot>
              PR opened · {pr.selectedRepoFullName}
            </Chip>
          </a>
        )}
        {pr && pr.openStatus === "pending" && (
          <Chip tone="neutral" dot>
            PR pending · {pr.selectedRepoFullName}
          </Chip>
        )}
        {pr && pr.validationPassed === false && (
          <Chip tone="danger" dot>
            Patch validation failed
          </Chip>
        )}
        {ticket && ticket.url && (
          <a href={ticket.url} target="_blank" rel="noreferrer" className="text-[12px]">
            <Chip tone="success" dot>
              {ticket.createdByAgent
                ? `Ticket filed · ${ticket.id}`
                : `Ticket updated · ${ticket.id}`}
            </Chip>
          </a>
        )}
        {ticket && !ticket.url && (
          <Chip tone="success" dot>
            {ticket.createdByAgent
              ? `Ticket filed · ${ticket.id}`
              : `Ticket updated · ${ticket.id}`}
          </Chip>
        )}
      </div>
    </div>
  );
}

function AgentRunStateChip({ state }: { state: string }) {
  if (state === "complete") {
    return (
      <Chip tone="success" dot>
        {state}
      </Chip>
    );
  }
  if (state === "failed") {
    return (
      <Chip tone="danger" dot>
        {state}
      </Chip>
    );
  }
  if (state === "awaiting_human") {
    return (
      <Chip tone="warning" dot>
        {state}
      </Chip>
    );
  }
  if (state === "pr_retry_queued") {
    return (
      <Chip tone="warning" dot>
        retrying PR
      </Chip>
    );
  }
  if (state === "blocked_no_github") {
    return (
      <Chip tone="warning" dot>
        blocked: no github
      </Chip>
    );
  }
  return <Chip tone="neutral">{state}</Chip>;
}

function AgentRunEventRow({ event }: { event: IncidentEvent }) {
  const [expanded, setExpanded] = useState(false);
  const summary = (event.summary ?? "").trim() || humanizeKind(event.kind);
  const firstLine = summary.split("\n", 1)[0] ?? "";
  const isTruncatable = summary.length > firstLine.length || firstLine.length > 120;
  const isAgent = event.kind.startsWith("agent.");
  const tag = agentKindTag(event.kind);

  if (event.source === "agent_pr" || event.source === "agent_linear") {
    return <ExternalEventRow event={event} />;
  }

  const time = (
    <span className="shrink-0 whitespace-nowrap text-[11px] text-subtle">
      · {fmtRelative(event.createdAt)}
    </span>
  );

  if (!isAgent) {
    return (
      <li className="pl-3">
        {expanded ? (
          <>
            <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted">
              {summary}
            </pre>
            <div className="mt-0.5">{time}</div>
          </>
        ) : (
          <div className="flex items-baseline gap-2 text-[12px] text-muted">
            <span className="min-w-0 flex-1 truncate">{firstLine}</span>
            {time}
          </div>
        )}
        {isTruncatable && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 text-[11px] text-subtle hover:text-fg"
          >
            {expanded ? "show less" : "show more"}
          </button>
        )}
      </li>
    );
  }

  return (
    <li className="border-l-2 border-white/10 pl-3">
      {tag && (
        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-subtle">
          {tag}
        </div>
      )}
      {expanded ? (
        <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg">
          {summary}
        </pre>
      ) : (
        <p className="line-clamp-2 text-[12px] leading-relaxed text-fg">{firstLine}</p>
      )}
      <div className="mt-0.5 flex items-center gap-2">
        {time}
        {isTruncatable && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-subtle hover:text-fg"
          >
            {expanded ? "show less" : "show more"}
          </button>
        )}
      </div>
    </li>
  );
}

function ExternalEventRow({ event }: { event: IncidentEvent }) {
  const tag = event.source === "agent_pr" ? "github" : "linear";
  const summary = (event.summary ?? "").trim() || humanizeKind(event.kind);
  const detail = event.detail ?? {};
  const detailUrl =
    (typeof detail.html_url === "string" && detail.html_url) ||
    (typeof detail.prUrl === "string" && detail.prUrl) ||
    (typeof detail.ticketUrl === "string" && detail.ticketUrl) ||
    null;
  const actor = event.actor;

  return (
    <li className="border-l-2 border-white/10 pl-3">
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-subtle">
        {tag}
      </div>
      <div className="flex items-start gap-2 text-[12px] leading-relaxed">
        {actor?.avatarUrl && (
          <img
            src={actor.avatarUrl}
            alt={actor.name ?? ""}
            className="mt-0.5 h-4 w-4 rounded-full"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-fg">
            {actor?.name && (
              <>
                {actor.profileUrl ? (
                  <a
                    href={actor.profileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-fg hover:underline"
                  >
                    {actor.name}
                  </a>
                ) : (
                  <span className="font-medium text-fg">{actor.name}</span>
                )}
                <span className="text-muted"> · </span>
              </>
            )}
            <span className="text-muted">{summary}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-subtle">
            <span>{fmtRelative(event.createdAt)}</span>
            {detailUrl && (
              <a
                href={detailUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-fg hover:underline"
              >
                view
              </a>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

type TimelineItem =
  | { kind: "single"; event: IncidentEvent }
  | { kind: "tool_pair"; call: IncidentEvent; result: IncidentEvent };

function pairToolEvents(events: IncidentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const next = events[i + 1];
    if (event.kind === "agent.tool_use" && next?.kind === "agent.tool_result") {
      items.push({ kind: "tool_pair", call: event, result: next });
      i++;
    } else {
      items.push({ kind: "single", event });
    }
  }
  return items;
}

function ToolCallRow({
  call,
  result,
}: {
  call: IncidentEvent;
  result: IncidentEvent;
}) {
  const [expanded, setExpanded] = useState(false);
  const callSummary = (call.summary ?? "").trim() || humanizeKind(call.kind);
  const callFirstLine = callSummary.split("\n", 1)[0] ?? "";
  const resultSummary = (result.summary ?? "").trim();

  return (
    <li className="border-l-2 border-white/10 pl-3">
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-subtle">
        tool call
      </div>
      {expanded ? (
        <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg">
          {callSummary}
        </pre>
      ) : (
        <p className="line-clamp-2 text-[12px] leading-relaxed text-fg">{callFirstLine}</p>
      )}
      {expanded && resultSummary && (
        <div className="mt-2 border-l border-border pl-3">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-subtle">
            result
          </div>
          <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted">
            {resultSummary}
          </pre>
        </div>
      )}
      <div className="mt-0.5 flex items-center gap-2">
        <span className="shrink-0 whitespace-nowrap text-[11px] text-subtle">
          · {fmtRelative(call.createdAt)}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-subtle hover:text-fg"
        >
          {expanded ? "hide result" : "show result"}
        </button>
      </div>
    </li>
  );
}

function agentKindTag(kind: string): string | null {
  if (kind === "agent.thinking") return "thinking";
  if (kind === "agent.message") return "agent";
  if (kind === "agent.tool_use") return "tool call";
  if (kind === "agent.tool_result") return "tool result";
  if (kind.startsWith("agent.")) return kind.slice("agent.".length).replace(/_/g, " ");
  return null;
}

function humanizeKind(kind: string): string {
  const cleaned = kind.replace(/[._]/g, " ").trim().toLowerCase();
  if (!cleaned) return kind;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ---------------------------------------------------------------------------
// Timeline grouping (story view)
// ---------------------------------------------------------------------------

type ToolUseDetail = {
  name: string;
  input: Record<string, unknown>;
  mcpServerName?: string;
};

type ToolResultDetail = {
  toolUseId?: string;
  isError: boolean;
};

type SpanDetail = {
  modelRequestStartId?: string;
  modelUsage?: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  isError: boolean;
};

function readToolUse(event: IncidentEvent): ToolUseDetail | null {
  const detail = event.detail as { toolUse?: ToolUseDetail } | null;
  return detail?.toolUse ?? null;
}

function readToolResult(event: IncidentEvent): ToolResultDetail | null {
  const detail = event.detail as { toolResult?: ToolResultDetail } | null;
  return detail?.toolResult ?? null;
}

function readSpan(event: IncidentEvent): SpanDetail | null {
  const detail = event.detail as { span?: SpanDetail } | null;
  return detail?.span ?? null;
}

type TurnToolCall = {
  callEvent: IncidentEvent;
  toolUse: ToolUseDetail | null;
  resultEvent: IncidentEvent | null;
  resultIsError: boolean;
};

type Turn = {
  startEvent: IncidentEvent;
  endEvent: IncidentEvent | null;
  durationMs: number | null;
  thinkingCount: number;
  message: string | null;
  messageEvent: IncidentEvent | null;
  toolCalls: TurnToolCall[];
  usage: SpanDetail["modelUsage"] | null;
  isError: boolean;
};

type TimelineNode = { kind: "turn"; turn: Turn } | { kind: "marker"; event: IncidentEvent };

function groupEvents(events: IncidentEvent[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  let current: Turn | null = null;
  const callsById = new Map<string, TurnToolCall>();

  const closeTurn = () => {
    if (current) {
      nodes.push({ kind: "turn", turn: current });
      current = null;
    }
  };

  for (const event of events) {
    if (event.kind === "span.model_request_start") {
      closeTurn();
      current = {
        startEvent: event,
        endEvent: null,
        durationMs: null,
        thinkingCount: 0,
        message: null,
        messageEvent: null,
        toolCalls: [],
        usage: null,
        isError: false,
      };
      continue;
    }
    if (event.kind === "span.model_request_end") {
      if (current) {
        const span = readSpan(event);
        current.endEvent = event;
        current.usage = span?.modelUsage ?? null;
        current.isError = span?.isError ?? false;
        const startMs = new Date(current.startEvent.createdAt).getTime();
        const endMs = new Date(event.createdAt).getTime();
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          current.durationMs = Math.max(0, endMs - startMs);
        }
        closeTurn();
      }
      continue;
    }
    if (event.kind === "agent.thinking") {
      if (current) current.thinkingCount += 1;
      continue;
    }
    if (event.kind === "agent.message") {
      if (current) {
        current.message = (event.summary ?? "").trim() || null;
        current.messageEvent = event;
      } else {
        nodes.push({ kind: "marker", event });
      }
      continue;
    }
    if (
      event.kind === "agent.tool_use" ||
      event.kind === "agent.mcp_tool_use" ||
      event.kind === "agent.custom_tool_use"
    ) {
      const call: TurnToolCall = {
        callEvent: event,
        toolUse: readToolUse(event),
        resultEvent: null,
        resultIsError: false,
      };
      if (current) current.toolCalls.push(call);
      else nodes.push({ kind: "marker", event });
      // tool_results carry the provider's tool_use_id (Anthropic `sevt_…`),
      // which equals the tool_use event's provider_event_id — not its row id.
      const key = event.providerEventId ?? event.id;
      callsById.set(key, call);
      continue;
    }
    if (event.kind === "agent.tool_result" || event.kind === "agent.mcp_tool_result") {
      const result = readToolResult(event);
      const callId = result?.toolUseId ?? null;
      const matched = callId ? callsById.get(callId) : null;
      if (matched) {
        matched.resultEvent = event;
        matched.resultIsError = result?.isError ?? false;
      } else {
        nodes.push({ kind: "marker", event });
      }
      continue;
    }
    nodes.push({ kind: "marker", event });
  }

  closeTurn();
  return nodes;
}

// ---------------------------------------------------------------------------
// Timeline view (story / trace toggle)
// ---------------------------------------------------------------------------

function TimelineView({ events }: { events: IncidentEvent[] }) {
  const [view, setView] = useState<"highlights" | "trace">("highlights");
  const highlights = view === "highlights" ? highlightEvents(events) : null;
  const traceNodes = view === "trace" ? groupEvents(events) : null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-[11px]">
        <ViewToggleButton active={view === "highlights"} onClick={() => setView("highlights")}>
          Highlights
        </ViewToggleButton>
        <ViewToggleButton active={view === "trace"} onClick={() => setView("trace")}>
          Full trace
        </ViewToggleButton>
        <span className="ml-2 text-subtle">
          {view === "highlights" && highlights
            ? `${highlights.length} of ${events.length} events`
            : `${events.length} events`}
        </span>
      </div>
      {view === "highlights" && highlights && (
        <ul className="flex flex-col">
          {highlights.map((event) => (
            <HighlightRow key={event.id} event={event} />
          ))}
        </ul>
      )}
      {view === "trace" && traceNodes && (
        <ul className="flex flex-col gap-2">
          {traceNodes.map((node) =>
            node.kind === "turn" ? (
              <TurnRow key={node.turn.startEvent.id} turn={node.turn} />
            ) : (
              <AgentRunEventRow key={node.event.id} event={node.event} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

// Narrative subset of the timeline: lifecycle markers, repo/issue context,
// PR + ticket activity, and the agent's spoken messages. Tool calls and
// model-span instrumentation are intentionally hidden — they belong in the
// full trace. agent.thinking events are also dropped: Anthropic's managed
// agents API ships them as content-free heartbeats ("model is thinking"),
// not as carriers of the actual thought text.
function highlightEvents(events: IncidentEvent[]): IncidentEvent[] {
  const NARRATIVE_KINDS = new Set([
    "agent_run_queued",
    "agent_run_started",
    "agent_run_restarted",
    "agent_run_pr_retry_queued",
    "agent_run_superseded",
    "agent_run_failed",
    "awaiting_human",
    "incident_resolved",
    "incident_reopened",
    "repo_selected",
    "incident_context_changed",
    "agent.message",
    "session.error",
  ]);
  return events.filter(
    (e) => e.source === "agent_pr" || e.source === "agent_linear" || NARRATIVE_KINDS.has(e.kind),
  );
}

// One-line, Linear-style activity-feed row used by Highlights. Format:
//   <icon>  <actor> <verb-phrase>  · <time>  [view]
//           [optional expandable body]
//
// Lifecycle / system events render with a small bullet (no actor); agent
// speech renders with an "Agent" label; PR/Linear events use the actor that
// the API attached (e.g. `cursor[bot]`, `superlog-app[bot]`).
function HighlightRow({ event }: { event: IncidentEvent }) {
  const [expanded, setExpanded] = useState(false);
  const view = renderHighlight(event);

  const time = (
    <span className="shrink-0 whitespace-nowrap text-[11px] text-subtle">
      · {fmtRelative(event.createdAt)}
    </span>
  );
  const viewLink = view.detailUrl ? (
    <a
      href={view.detailUrl}
      target="_blank"
      rel="noreferrer"
      className="shrink-0 text-[11px] text-subtle hover:text-fg hover:underline"
    >
      view
    </a>
  ) : null;

  return (
    <li className="flex gap-3 py-1.5">
      <div className="flex w-5 shrink-0 justify-center pt-1">
        <HighlightIcon variant={view.iconKind} actor={view.actor} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] leading-relaxed">
          {view.actor?.name &&
            (view.actor.profileUrl ? (
              <a
                href={view.actor.profileUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-fg hover:underline"
              >
                {view.actor.name}
              </a>
            ) : (
              <span className="font-medium text-fg">{view.actor.name}</span>
            ))}
          <span className="min-w-0 flex-1 text-muted">{view.inline}</span>
          {viewLink}
          {time}
        </div>
        {view.expandable && (
          <>
            <div
              className={
                expanded
                  ? "mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg"
                  : "hidden"
              }
            >
              {view.expandable}
            </div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 text-[11px] text-subtle hover:text-fg"
            >
              {expanded ? "show less" : "show more"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function HighlightIcon({
  variant,
  actor,
}: {
  variant: "actor" | "agent" | "system";
  actor: IncidentEvent["actor"] | null | undefined;
}) {
  if (variant === "actor" && actor?.avatarUrl) {
    return <img src={actor.avatarUrl} alt={actor.name ?? ""} className="h-4 w-4 rounded-full" />;
  }
  if (variant === "agent") {
    return (
      <div className="flex h-4 w-4 items-center justify-center rounded-full bg-white/10 text-[9px] font-medium uppercase tracking-tight text-fg">
        A
      </div>
    );
  }
  // System (lifecycle / context) — simple ring.
  return <div className="h-2 w-2 rounded-full border border-white/30" />;
}

type HighlightView = {
  actor: AgentRunEventActor | null;
  iconKind: "actor" | "agent" | "system";
  inline: string;
  detailUrl?: string | null;
  expandable?: string | null;
};

const CONTEXT_PREFIX = /^new issue joined the incident:\s*/i;
const HIGHLIGHT_PREVIEW_LIMIT = 140;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

// Snake-case reason codes (`fixed_in_current_code`, `external_dependency_recovered`,
// agent-emitted free-form codes from autorecovery) → "fixed in current code".
// Kept loose because the autorecovery agent is intentionally free to coin new
// categories without a frontend change.
function humanizeReasonCode(code: string): string {
  return code.replace(/[._]/g, " ").trim().toLowerCase();
}

// Capitalize the first letter only, leave the rest of the words lowercase.
// Tailwind's `capitalize` uppercases every word — too loud for titles like
// "Transient load resolved" where only the first word should be cased.
function sentenceCase(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function renderHighlight(event: IncidentEvent): HighlightView {
  const detail = (event.detail ?? {}) as Record<string, unknown>;

  if (event.source === "agent_pr") {
    const prNumber = typeof detail.prNumber === "number" ? detail.prNumber : null;
    const repo = typeof detail.repoFullName === "string" ? detail.repoFullName : null;
    const prUrl = typeof detail.prUrl === "string" ? detail.prUrl : null;
    let inline: string;
    switch (event.kind) {
      case "pr_opened":
        inline = prNumber
          ? `opened PR #${prNumber}${repo ? ` in ${repo}` : ""}`
          : "opened a pull request";
        break;
      case "pr_merged":
        inline = prNumber ? `merged PR #${prNumber}` : "merged the pull request";
        break;
      case "pr_closed":
        inline = prNumber ? `closed PR #${prNumber}` : "closed the pull request";
        break;
      case "pr_edited":
      case "pr_synchronize":
        inline = "updated the PR";
        break;
      default:
        inline = humanizeKind(event.kind).toLowerCase();
    }
    return { actor: event.actor ?? null, iconKind: "actor", inline, detailUrl: prUrl };
  }

  if (event.source === "agent_linear") {
    const ticketId = typeof detail.ticketIdentifier === "string" ? detail.ticketIdentifier : null;
    const ticketUrl = typeof detail.ticketUrl === "string" ? detail.ticketUrl : null;
    let inline: string;
    switch (event.kind) {
      case "ticket_filed":
        inline = ticketId ? `filed Linear ticket ${ticketId}` : "filed a Linear ticket";
        break;
      case "ticket_state_changed": {
        const next = typeof detail.toState === "string" ? detail.toState : null;
        inline = ticketId
          ? `moved ${ticketId}${next ? ` to ${next}` : ""}`
          : "moved the Linear ticket";
        break;
      }
      default:
        inline = humanizeKind(event.kind).toLowerCase();
    }
    // Linear events historically arrive without an actor; fall back to the
    // agent so the row reads as a sentence rather than a floating verb.
    const actor: AgentRunEventActor = event.actor ?? {
      name: "Agent",
      avatarUrl: null,
      profileUrl: null,
    };
    return { actor, iconKind: "actor", inline, detailUrl: ticketUrl };
  }

  if (event.kind === "agent.message") {
    const body = (event.summary ?? "").trim();
    const firstLine = body.split("\n", 1)[0] ?? body;
    const truncated = truncate(firstLine, HIGHLIGHT_PREVIEW_LIMIT);
    const hasMore = body.length > truncated.length;
    const actor: AgentRunEventActor = {
      name: "Agent",
      avatarUrl: null,
      profileUrl: null,
    };
    return {
      actor,
      iconKind: "agent",
      inline: truncated,
      expandable: hasMore ? body : null,
    };
  }

  let inline: string;
  switch (event.kind) {
    case "agent_run_queued":
      inline = "queued agent run";
      break;
    case "agent_run_started": {
      const repoCount =
        typeof detail.candidateCount === "number"
          ? detail.candidateCount
          : typeof detail.repoCandidateCount === "number"
            ? detail.repoCandidateCount
            : null;
      inline = repoCount
        ? `started agent run across ${repoCount} candidate repo${repoCount === 1 ? "" : "s"}`
        : "started agent run";
      break;
    }
    case "agent_run_restarted":
      inline = "restarted agent run";
      break;
    case "agent_run_pr_retry_queued":
      inline = "queued PR delivery retry";
      break;
    case "agent_run_superseded":
      inline = "superseded earlier agent run";
      break;
    case "agent_run_failed":
      inline = (event.summary ?? "").trim() || "agent run failed";
      break;
    case "awaiting_human":
      inline = "paused for human input";
      break;
    case "incident_resolved": {
      // Detail JSON shape comes from packages/db/src/resolve-incident.ts:
      // { kind, reasonCode, reasonText, resolvedByUserId, resolvedBySlackUserId,
      //   resolvedIssueCount, ...legacy PR-merge fields }
      const kind = typeof detail.kind === "string" ? detail.kind : null;
      const reasonCode = typeof detail.reasonCode === "string" ? detail.reasonCode : null;
      const reasonText = typeof detail.reasonText === "string" ? detail.reasonText.trim() : null;
      const slackUserId =
        typeof detail.resolvedBySlackUserId === "string" ? detail.resolvedBySlackUserId : null;
      const prNumber = typeof detail.prNumber === "number" ? detail.prNumber : null;
      const repoFullName = typeof detail.repoFullName === "string" ? detail.repoFullName : null;
      const reasonLabel = reasonCode ? humanizeReasonCode(reasonCode) : null;
      switch (kind) {
        case "agent_pr_merged":
          inline = prNumber
            ? `resolved · PR #${prNumber}${repoFullName ? ` in ${repoFullName}` : ""} merged`
            : "resolved when the agent's PR was merged";
          break;
        case "agent_classification":
          inline = reasonLabel
            ? `resolved by investigation · ${reasonLabel}`
            : "resolved by investigation";
          break;
        case "slack_manual":
          inline = slackUserId ? `resolved from Slack by <@${slackUserId}>` : "resolved from Slack";
          break;
        case "dashboard_manual":
          inline = "resolved from the dashboard";
          break;
        case "autorecovery_confirmed":
          // "autorecovery proposal" is internal jargon — describe what the user
          // experienced: the system detected recovery, a teammate confirmed.
          inline = reasonLabel
            ? `auto-detected recovery · ${reasonLabel}${
                slackUserId ? ` · confirmed by <@${slackUserId}>` : ""
              }`
            : `auto-detected recovery${slackUserId ? ` · confirmed by <@${slackUserId}>` : ""}`;
          break;
        default:
          inline = (event.summary ?? "").trim() || "resolved the incident";
      }
      // Expose the agent/PR-merge evidence as the expandable body so the
      // viewer can drill into "why" without leaving the timeline.
      return {
        actor: null,
        iconKind: "system",
        inline,
        expandable: reasonText && reasonText.length > 0 ? reasonText : null,
      };
    }
    case "incident_reopened": {
      const reason = typeof detail.reason === "string" ? detail.reason : null;
      const issueTitle = typeof detail.issueTitle === "string" ? detail.issueTitle.trim() : null;
      switch (reason) {
        case "issue_regressed":
          inline = issueTitle
            ? `reopened · linked issue recurred: ${truncate(issueTitle, HIGHLIGHT_PREVIEW_LIMIT)}`
            : "reopened · linked issue recurred";
          break;
        case "dashboard_manual":
          inline = "reopened from the dashboard";
          break;
        default:
          inline = (event.summary ?? "").trim() || "reopened the incident";
      }
      break;
    }
    case "repo_selected": {
      const repo =
        typeof detail.repoFullName === "string"
          ? detail.repoFullName
          : typeof detail.selectedRepoFullName === "string"
            ? detail.selectedRepoFullName
            : null;
      inline = repo ? `selected repo ${repo}` : (event.summary ?? "").trim() || "selected a repo";
      break;
    }
    case "incident_context_changed": {
      const raw = (event.summary ?? "").trim();
      const issueTitle = raw.replace(CONTEXT_PREFIX, "").trim();
      inline = issueTitle
        ? `issue joined the incident: ${truncate(issueTitle, HIGHLIGHT_PREVIEW_LIMIT)}`
        : "an issue joined the incident";
      break;
    }
    case "session.error":
      inline = (event.summary ?? "").trim() || "session error";
      break;
    default:
      inline = (event.summary ?? "").trim() || humanizeKind(event.kind).toLowerCase();
  }
  return { actor: null, iconKind: "system", inline };
}

function ViewToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded border border-white/20 bg-white/10 px-2 py-0.5 text-fg"
          : "rounded border border-transparent px-2 py-0.5 text-subtle hover:text-fg"
      }
    >
      {children}
    </button>
  );
}

function TurnRow({ turn }: { turn: Turn }) {
  const [expanded, setExpanded] = useState(false);
  const dur = turn.durationMs != null ? `${(turn.durationMs / 1000).toFixed(1)}s` : null;
  const out = turn.usage?.output_tokens ?? null;
  const cacheRead = turn.usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = turn.usage?.cache_creation_input_tokens ?? 0;
  const inputTok = turn.usage?.input_tokens ?? 0;
  const totalIn = cacheRead + cacheCreate + inputTok;
  const cachePct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : null;
  const hasTools = turn.toolCalls.length > 0;

  return (
    <li className="border-l-2 border-white/10 pl-3">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.1em] text-subtle">
        <span>turn</span>
        {dur && <span>· {dur}</span>}
        {out != null && <span>· {out} tok</span>}
        {cachePct != null && <span>· {cachePct}% cache</span>}
        {turn.isError && <span className="text-danger">· error</span>}
        <span className="ml-auto normal-case tracking-normal text-subtle">
          {fmtRelative(turn.startEvent.createdAt)}
        </span>
      </div>
      {turn.message && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg">
          {turn.message}
        </p>
      )}
      {hasTools && (
        <div className="mt-1 flex flex-wrap gap-1">
          {turn.toolCalls.map((call) => (
            <ToolChip key={call.callEvent.id} call={call} />
          ))}
        </div>
      )}
      {hasTools && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-subtle hover:text-fg"
          >
            {expanded ? "hide details" : "show details"}
          </button>
        </div>
      )}
      {expanded && hasTools && (
        <div className="mt-2 flex flex-col gap-2">
          {turn.toolCalls.map((call) => (
            <ToolCallDetail key={call.callEvent.id} call={call} />
          ))}
        </div>
      )}
    </li>
  );
}

function toolDisplayName(call: TurnToolCall): string {
  const tu = call.toolUse;
  if (!tu) {
    const fallback = (call.callEvent.summary ?? "").trim();
    return fallback || humanizeKind(call.callEvent.kind);
  }
  return tu.mcpServerName ? `${tu.mcpServerName}.${tu.name}` : tu.name;
}

function ToolChip({ call }: { call: TurnToolCall }) {
  const name = toolDisplayName(call);
  const tone = call.resultIsError ? "danger" : "neutral";
  return (
    <Chip tone={tone} dot={call.resultIsError}>
      {name}
    </Chip>
  );
}

function ToolCallDetail({ call }: { call: TurnToolCall }) {
  const name = toolDisplayName(call);
  const inputJson = call.toolUse
    ? JSON.stringify(call.toolUse.input, null, 2)
    : (call.callEvent.summary ?? "").trim();
  const resultText = (call.resultEvent?.summary ?? "").trim();
  return (
    <div className="border-l border-border pl-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-subtle">
        {name}
        {call.resultIsError && <span className="ml-2 text-danger">error</span>}
      </div>
      {inputJson && (
        <pre className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg">
          {inputJson}
        </pre>
      )}
      {resultText && (
        <div className="mt-2 border-l border-border pl-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-subtle">
            result
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted">
            {resultText}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function kindLabel(kind: string): string {
  if (kind === "span") return "trace";
  return kind;
}

function kindTone(kind: string): "neutral" | "accent" | "warning" {
  if (kind === "alert") return "warning";
  if (kind === "log") return "accent";
  return "neutral"; // trace / span
}

function eventTargetFromIssue(issue: Issue): NonNullable<EventTarget> | null {
  const sample = issue.lastSample;
  if (!sample) return null;
  if (issue.kind === "span") {
    return sample.traceId
      ? { kind: "trace", traceId: sample.traceId, spanId: sample.spanId || undefined }
      : null;
  }
  if (issue.kind === "log") {
    const log: LogRow = {
      timestamp: sample.seenAt,
      service: sample.service ?? "",
      severity: sample.severity ?? "",
      severity_number: sample.severityNumber ?? 0,
      body: sample.body ?? "",
      trace_id: sample.traceId ?? "",
      span_id: sample.spanId ?? "",
      log_attrs: sample.logAttrs ?? {},
      resource_attrs: sample.resourceAttrs ?? {},
    };
    return { kind: "log", log };
  }
  return null;
}

function KindChip({ issue }: { issue: Issue }) {
  return <Chip tone={kindTone(issue.kind)}>{kindLabel(issue.kind)}</Chip>;
}

// Deployment environment ("production", "staging", …) read off a telemetry
// resource-attr map. Mirrors `environmentFromResourceAttrs` in @superlog/db —
// keep the key list in sync.
function environmentFromAttrs(attrs: Record<string, string> | null | undefined): string | null {
  if (!attrs) return null;
  for (const key of ["deployment.environment.name", "deployment.environment", "env"]) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function issueEnvironment(issue: Issue): string | null {
  return environmentFromAttrs(issue.lastSample?.resourceAttrs);
}

// `service | environment`, joined in one same-font run. Either side is dropped
// when missing; renders nothing when both are absent.
function ServiceEnv({
  service,
  environment,
}: {
  service: string | null | undefined;
  environment: string | null | undefined;
}) {
  const parts = [service, environment].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return <span className="font-mono text-[11px] text-subtle">{parts.join(" | ")}</span>;
}

function GroupingChip({ state }: { state: Issue["groupingState"] }) {
  if (state === "pending") return <Chip tone="warning">analysing</Chip>;
  if (state === "failed") return <Chip tone="danger">grouping failed</Chip>;
  return null;
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <SectionHeader>{label}</SectionHeader>
      <p className="mt-0.5 font-mono text-[12px] text-fg">{value}</p>
    </div>
  );
}

function MetaInline({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <SectionHeader>{label}</SectionHeader>
      <span className="font-mono text-[12px] text-fg">{value}</span>
    </span>
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  return <div className="text-[11px] text-subtle">{children}</div>;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <div className="text-[14px] font-semibold text-fg">{children}</div>;
}

function resolutionReasonLabel(reason: string): string {
  switch (reason) {
    case "fixed_in_current_code":
      return "fixed in code";
    case "transient_condition_cleared":
      return "condition cleared";
    case "upstream_recovered":
      return "upstream recovered";
    default:
      return reason;
  }
}

export function SeverityChip({ severity }: { severity: string }) {
  const tone = severity === "SEV-1" ? "danger" : severity === "SEV-2" ? "warning" : "neutral";
  return (
    <Chip tone={tone} dot>
      {severity}
    </Chip>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(10, Math.round(value)));
  const toneClass = clamped >= 8 ? "text-success" : clamped >= 5 ? "text-warning" : "text-danger";
  return (
    <span className={`font-mono text-[11px] tabular-nums ${toneClass}`}>
      confidence {clamped}/10
    </span>
  );
}

const ISSUE_LIST_DEFAULT_LIMIT = 3;

function IssueList({
  issues,
  onViewIssue,
}: {
  issues: Issue[];
  onViewIssue: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? issues : issues.slice(0, ISSUE_LIST_DEFAULT_LIMIT);
  const hidden = issues.length - visible.length;
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border border border-border">
        {visible.map((issue) => (
          <li key={issue.id} className="px-3 py-2">
            <button
              onClick={() => onViewIssue(issue.id)}
              className="block w-full min-w-0 overflow-hidden text-left transition-colors hover:text-muted"
            >
              <div className="mb-0.5 flex items-center gap-2">
                <KindChip issue={issue} />
                <span className="font-mono text-[11px] text-muted">{issue.exceptionType}</span>
                <span className="font-mono text-[11px] tabular-nums text-subtle">
                  {fmtCount(issue.eventCount)} event{issue.eventCount !== 1 ? "s" : ""}
                </span>
              </div>
              <p className="truncate text-[12px] text-fg">{issue.message ?? issue.title}</p>
            </button>
          </li>
        ))}
      </ul>
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-subtle hover:text-fg"
        >
          {expanded ? "show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}

function CollapsibleEvidenceSection({
  title,
  confidence,
  text,
  ctx,
}: {
  title: string;
  confidence: number;
  text: string;
  ctx: EvidenceLinkContext;
  // Retained for call-site compatibility but no longer respected — the body
  // is always shown, clamped to 3 lines, with an inline "show more" toggle.
  defaultOpen?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <SectionHeading>{title}</SectionHeading>
        <ConfidenceMeter value={confidence} />
      </div>
      <Clamp3>
        <EvidenceMarkdown text={text} ctx={ctx} />
      </Clamp3>
    </div>
  );
}

// Show the first ~3 lines of children; if there's more, render a "show more"
// toggle that expands to the full content. Uses scrollHeight to detect whether
// clamping actually hid anything, so the toggle disappears for short content.
function Clamp3({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const check = () => {
      // Only meaningful while clamped — if the user opened it, leave the
      // button visible so they can collapse again.
      if (open) return;
      setOverflowing(el.scrollHeight - el.clientHeight > 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children]);

  return (
    <div>
      <div ref={ref} className={open ? undefined : "line-clamp-3"}>
        {children}
      </div>
      {(overflowing || open) && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[11px] text-subtle hover:text-fg"
        >
          {open ? "show less" : "show more"}
        </button>
      )}
    </div>
  );
}

// Faint green "looks resolved" pill shown when the autorecovery agent has
// proposed resolution and nobody has confirmed/dismissed yet. Sans-serif (the
// Chip component is mono — we want sans here so the pill reads as a UI label,
// not a code badge).
export function RecoveryDetectedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] text-success"
      // Inline fill + border rather than Tailwind's `bg-success/N` /
      // `border-success/N` opacity modifiers — those arbitrary-opacity
      // classes weren't in the JIT scan set so they rendered as
      // transparent. `color-mix` builds the translucent green from
      // the existing variable.
      style={{
        backgroundColor: "color-mix(in srgb, var(--color-success) 22%, transparent)",
        borderColor: "color-mix(in srgb, var(--color-success) 25%, transparent)",
      }}
    >
      <HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} strokeWidth={2} />
      Recovery detected
    </span>
  );
}

export function StatusChip({
  status,
  pendingResolution = false,
}: {
  status: string;
  // True when the autorecovery agent has proposed resolution and nobody has
  // confirmed/dismissed yet. Replaces the red "open" pill with a green
  // "looks resolved" pill — one chip, not two, so the row still reads as
  // a single status at a glance.
  pendingResolution?: boolean;
}) {
  if (status === "open") {
    if (pendingResolution) {
      return <RecoveryDetectedBadge />;
    }
    return (
      <Chip tone="danger" dot>
        open
      </Chip>
    );
  }
  if (status === "resolved")
    return (
      <Chip tone="success" dot>
        resolved
      </Chip>
    );
  if (status === "autoresolved_noise") return <Chip tone="neutral">noise</Chip>;
  return <Chip tone="neutral">{status}</Chip>;
}

export function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
