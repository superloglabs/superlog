import {
  ChartIncreaseIcon,
  CheckmarkCircle02Icon,
  ClipboardCopyIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Fragment,
  type ReactNode,
  Suspense,
  lazy,
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
  incidentChatErrorMessage,
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
  useResolveAllRecoveryDetected,
  useRestartAgentRun,
  useRetryPrDelivery,
  useSendIncidentChatMessage,
  useSilenceIssue,
  useStartInvestigation,
  useUnsilenceIssue,
  useUpdateIncident,
} from "./api.ts";
import {
  Btn,
  Chip,
  OutOfCreditsBadge,
  OutOfCreditsBanner,
  PageHeader,
  Tabs,
} from "./design/ui.tsx";
import { type IncidentStatusAction, getIncidentStatusActions } from "./incident-status-action.ts";
import {
  IncidentActivityFeed,
  IncidentSummaryTelemetry,
  fmtRelative,
} from "./incidents/IncidentTranscript.tsx";
import {
  getIncidentDetailAccess,
  shouldUsePreloadedPullRequests,
} from "./incidents/incident-detail-access.ts";
import {
  type IncidentMetaRow,
  buildIncidentDetailMeta,
} from "./incidents/incident-detail-view-model.ts";
import { IncidentDetailScrollArea } from "./incidents/IncidentDetailScrollArea.tsx";
import { getIssueIncidentLinkState } from "./issue-incident-link-state.ts";
import { IssueDetailView } from "./issues/IssueDetailView.tsx";
import {
  IncidentDetailSkeleton,
  IncidentListSkeleton,
  IssueDetailSkeleton,
  IssueListSkeleton,
} from "./skeletons.tsx";

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
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const labels: Record<Tab, string> = { incidents: "Incidents", issues: "Errors" };

  if (tab === "incidents" && params.id) {
    return <IncidentsTab projectId={projectId} />;
  }

  if (tab === "issues" && params.id) {
    return (
      <IssueDetailPage
        projectId={projectId}
        issueId={params.id}
        onClose={() => navigate("/issues")}
        onViewIncident={(incidentId) => navigate(`/incidents/${incidentId}`)}
      />
    );
  }

  return (
    <div className="relative">
      <PageHeader
        title={labels[tab]}
        description={
          tab === "issues"
            ? "Triage recurring errors and follow investigations from first signal to resolution."
            : "Investigate operational incidents from first signal to resolution."
        }
      />
      <div className="mt-6">
        {tab === "issues" ? (
          <IssuesTab projectId={projectId} />
        ) : (
          <IncidentsTab projectId={projectId} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Errors tab
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
  const detailLoading = !!selectedId && !selected && (issues.isLoading || fetched.isLoading);

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
                  ? "rounded-md bg-surface-3 px-3 py-1.5 text-[13px] font-medium tracking-tight text-fg"
                  : "rounded-md px-3 py-1.5 text-[13px] font-medium tracking-tight text-muted hover:text-fg"
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        {issues.data && (
          <span className="text-[12px] text-muted">
            {issues.data.length} error{issues.data.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {issues.isLoading && <IssueListSkeleton />}
      {issues.error && (
        <div className="text-[13px] text-danger">Failed to load: {String(issues.error)}</div>
      )}
      {issues.data && issues.data.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-12 text-center">
          <p className="text-[13px] text-muted">
            No {filter === "all" ? "" : filter + " "}ungrouped errors
          </p>
        </div>
      )}
      {issues.data && issues.data.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
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
      {detailLoading && <IssueDrawerSkeleton onClose={() => selectIssue(null)} />}

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

function IssueDrawerSkeleton({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[720px] flex-col border-l border-border bg-bg shadow-2xl">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <IssueDetailSkeleton />
        </div>
      </aside>
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
            <IssueStatusChip issue={issue} />
            <GroupingChip state={issue.groupingState} />
            <span className="font-sans text-[11px] text-muted">{issue.exceptionType}</span>
            <ServiceEnv service={issue.service} environment={issueEnvironment(issue)} />
          </div>
          <p className="truncate text-[13px] font-medium text-fg">{issue.title}</p>
          {issue.message && (
            <p className="mt-0.5 truncate font-sans text-[11px] text-muted">{issue.message}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-sans text-[11px] tabular-nums text-muted">
            {fmtRelative(issue.lastSeen)}
          </div>
          <div className="mt-1 font-sans text-[11px] tabular-nums text-subtle">
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

function IssueDetailPage({
  projectId,
  issueId,
  onClose,
  onViewIncident,
}: {
  projectId: string;
  issueId: string;
  onClose: () => void;
  onViewIncident: (incidentId: string) => void;
}) {
  const q = useIssue(projectId, issueId);
  const activity = useIssueAgentRun(projectId, issueId);
  const silence = useSilenceIssue(projectId);
  const unsilence = useUnsilenceIssue(projectId);
  const [eventTarget, setEventTarget] = useState<EventTarget>(null);

  if (q.isLoading) {
    return <IssueDetailSkeleton />;
  }
  if (q.error || !q.data) {
    return (
      <div className="p-6 text-[12px] text-danger">
        Failed to load error: {String(q.error ?? "no data")}
      </div>
    );
  }

  const issue = q.data;
  const latestEvent = eventTargetFromIssue(issue);
  const toggleSilence = issue.silencedAt ? unsilence : silence;

  return (
    <>
      <IssueDetailView
        issue={issue}
        environment={issueEnvironment(issue)}
        onBack={onClose}
        onToggleSilence={() => toggleSilence.mutate(issue.id)}
        silenceUpdating={toggleSilence.isPending}
        onOpenEvidence={latestEvent ? () => setEventTarget(latestEvent) : undefined}
        evidenceLabel={latestEvent?.kind === "trace" ? "Open latest trace" : "Open latest log"}
        timelineEvents={activity.data?.events ?? []}
        linkedIncident={
          <IssueIncidentLink
            projectId={projectId}
            issueId={issue.id}
            groupingState={issue.groupingState}
            groupingReason={issue.groupingReason}
            onViewIncident={onViewIncident}
            showHeading={false}
          />
        }
        feedbackAction={
          <FeedbackTrigger
            kind="issue"
            refId={issue.id}
            projectId={projectId}
            className="w-full justify-center"
          />
        }
      />

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
    </>
  );
}

export function IssueDrawer(props: IssueDetailProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <div className="absolute inset-0">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={props.onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[720px] flex-col border-l border-border bg-bg shadow-2xl">
        <div className="min-h-0 flex-1 overflow-y-auto">
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
              <span className="font-sans text-[11px] text-muted">{issue.exceptionType}</span>
              <KindChip issue={issue} />
            </>
          )}
          <IssueStatusChip issue={issue} />
          <GroupingChip state={issue.groupingState} />
        </div>
        {issue.topFrame && (
          <div className="space-y-0.5">
            <SectionHeader>Top frame</SectionHeader>
            <p className="font-sans text-[12px] text-muted">{issue.topFrame}</p>
          </div>
        )}
      </div>

      {issue.message && (
        <div className="space-y-3">
          <SectionHeading>Error body</SectionHeading>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-2 px-3 py-2 font-sans text-[11px] text-fg">
            {issue.message}
          </pre>
        </div>
      )}

      {issue.symbolication && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <SectionHeading>Original stack</SectionHeading>
            <span className="font-sans text-[10px] text-subtle">
              {issue.symbolication.artifact.platform} - {issue.symbolication.artifact.release}
            </span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-2 px-3 py-2 font-sans text-[11px] text-fg">
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
  showHeading = true,
}: {
  projectId: string;
  issueId: string;
  groupingState: Issue["groupingState"];
  groupingReason: string | null;
  onViewIncident?: (incidentId: string) => void;
  showHeading?: boolean;
}) {
  const q = useIssueAgentRun(projectId, issueId);
  const incident = q.data?.incident ?? null;
  const linkState = getIssueIncidentLinkState({
    groupingState,
    incident,
    isLoading: q.isLoading,
  });
  const heading = showHeading ? <SectionHeading>Incident</SectionHeading> : null;

  if (linkState === "pending") {
    return (
      <div className="space-y-3">
        {heading}
        <p className="text-[12px] text-muted">Analysing — grouping in progress.</p>
      </div>
    );
  }
  if (linkState === "failed") {
    return (
      <div className="space-y-3">
        {heading}
        <p className="text-[12px] text-danger">Grouping analysis failed.</p>
      </div>
    );
  }
  // grouped or standalone — both can have a dedicated incident; standalone
  // just means the issue was not bundled together with other issues.
  if (linkState === "loading") {
    return (
      <div className="space-y-3">
        {heading}
        <p className="text-[12px] text-muted">loading…</p>
      </div>
    );
  }
  if (!incident) {
    return (
      <div className="space-y-3">
        {heading}
        <p className="text-[12px] text-muted">
          {groupingState === "standalone"
            ? "Standalone — not bundled with other errors."
            : "loading…"}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {heading}
      <button
        type="button"
        onClick={() => onViewIncident?.(incident.id)}
        className="block w-full rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-3"
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
  const [newInvestigationOpen, setNewInvestigationOpen] = useState(false);
  const { id: selectedId, openItem, closeItem } = useNav();
  const incidents = useIncidents(projectId, status);
  const resolveAllRecovery = useResolveAllRecoveryDetected(projectId);

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

  if (selectedId) {
    return (
      <IncidentDetailPage
        projectId={projectId}
        incidentId={selectedId}
        onClose={() => selectIncident(null)}
        onViewIssue={(issueId) => openItem(issueId, "issues")}
      />
    );
  }

  return (
    <div className="relative">
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
                  ? "rounded-md bg-surface-3 px-3 py-1.5 text-[13px] font-medium tracking-tight text-fg"
                  : "rounded-md px-3 py-1.5 text-[13px] font-medium tracking-tight text-muted hover:text-fg"
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {incidents.data && (
            <span className="text-[12px] text-muted">
              {incidents.data.length} incident{incidents.data.length !== 1 ? "s" : ""}
            </span>
          )}
          <Btn variant="primary" size="sm" onClick={() => setNewInvestigationOpen(true)}>
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            New investigation
          </Btn>
        </div>
      </div>

      {incidents.isLoading && <IncidentListSkeleton />}
      {incidents.error && (
        <div className="text-[13px] text-danger">Failed to load: {String(incidents.error)}</div>
      )}
      {incidents.data && incidents.data.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-12 text-center">
          <p className="text-[13px] text-muted">
            No {status === "all" ? "" : status + " "}incidents
          </p>
        </div>
      )}
      {incidents.data && incidents.data.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key}>
              <div className="mb-2 flex items-center justify-between px-1">
                <h3 className="text-[11px] font-medium text-muted">{group.label}</h3>
                {group.key === "recovery" && (
                  <Btn
                    variant="secondary"
                    size="sm"
                    loading={resolveAllRecovery.isPending}
                    onClick={() => {
                      const targets = group.items
                        .filter((r) => r.pendingResolutionProposal != null)
                        .map((r) => ({
                          incidentId: r.incident.id,
                          proposalId: r.pendingResolutionProposal!.id,
                        }));
                      if (targets.length > 0) resolveAllRecovery.mutate(targets);
                    }}
                  >
                    Resolve all {group.items.length}
                  </Btn>
                )}
              </div>
              {group.key === "recovery" && resolveAllRecovery.isError && (
                <div className="mb-2 px-1 text-[12px] text-danger">
                  Couldn't resolve all incidents:{" "}
                  {String(resolveAllRecovery.error).replace(/^Error:\s*/, "")}. Some may have
                  resolved — refresh to see the current state.
                </div>
              )}
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
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

      {newInvestigationOpen && (
        <NewInvestigationModal
          projectId={projectId}
          onClose={() => setNewInvestigationOpen(false)}
          onStarted={(incidentId) => {
            setNewInvestigationOpen(false);
            selectIncident(incidentId);
          }}
        />
      )}
    </div>
  );
}

// Modal to start a custom investigation from a typed prompt — the entry point
// for "something feels off but nothing alerted". Creates the incident + a queued
// manual agent run, then opens the new incident.
function NewInvestigationModal({
  projectId,
  onClose,
  onStarted,
}: {
  projectId: string;
  onClose: () => void;
  onStarted: (incidentId: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const start = useStartInvestigation(projectId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function submit() {
    const p = prompt.trim();
    if (!p || start.isPending) return;
    start.mutate({ prompt: p }, { onSuccess: (res) => onStarted(res.incident.id) });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative w-full max-w-[540px] overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl">
        <div className="px-5 pt-5">
          <h2 className="text-[17px] font-semibold tracking-tight text-fg">New investigation</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Describe what feels wrong. The agent queries your telemetry — traces, logs and metrics —
            and reports back, even if nothing alerted.
          </p>
        </div>
        <div className="px-5 py-4">
          <textarea
            autoFocus
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Checkout feels slow for some users in the last hour, but no incident fired. Can you check whether there's elevated latency or errors on the checkout path?"
            className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-[14px] leading-relaxed text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
          <p className="mt-2 text-[12px] text-muted">
            The agent decides which signals to pull and over what window — each query shows up in
            the transcript.
          </p>
          {start.error && (
            <p className="mt-2 text-[12px] text-danger">
              Couldn't start: {String(start.error).replace(/^Error:\s*/, "")}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-surface px-5 py-3.5">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            onClick={submit}
            loading={start.isPending}
            disabled={!prompt.trim()}
          >
            Start investigation
          </Btn>
        </div>
      </div>
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
  const { incident, agentRun, pendingResolutionProposal } = row;
  const outOfCredits = !agentRun && incident.autoInvestigateBlockedReason === "no_credits";
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
            {outOfCredits && <OutOfCreditsBadge />}
          </div>
          <p className="truncate text-[13px] font-medium text-fg">{incident.title}</p>
          {incident.codename && (
            <p className="mt-0.5 font-sans text-[11px] text-subtle">{incident.codename}</p>
          )}
        </div>
        <div className="hidden shrink-0 self-center sm:block">
          <LazyRowSparkline activity={activity} error={!!stats.error} />
        </div>
        <div className="shrink-0 text-right">
          <div className="font-sans text-[11px] tabular-nums text-muted">
            {fmtRelative(incident.lastSeen)}
          </div>
          <LazyRowUsersImpacted activity={activity} error={!!stats.error} />
        </div>
      </div>
    </button>
  );
}

function IncidentDetailPage({
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
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
      <IncidentDetailBody
        projectId={projectId}
        incidentId={incidentId}
        onClose={onClose}
        onViewIssue={onViewIssue}
      />
    </div>
  );
}

function IncidentDetailBody({
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
  const stats = useIncidentStats(projectId, incidentId);
  const updateIncident = useUpdateIncident(projectId);
  const restartAgentRun = useRestartAgentRun(projectId);
  const retryPrDelivery = useRetryPrDelivery(projectId);
  const decideProposal = useDecideResolutionProposal(projectId);

  if (q.isLoading) {
    return <IncidentDetailSkeleton />;
  }
  if (q.error || !q.data) {
    return (
      <div className="p-4 font-sans text-[11px] text-danger">
        failed: {String(q.error ?? "no data")}
      </div>
    );
  }
  const { incident, issues, agentRun, agentRuns, timeline, alertEpisodes } = q.data;

  function handleStatusAction(action: IncidentStatusAction) {
    updateIncident.mutate({
      incidentId: incident.id,
      status: action.targetStatus,
      resolution: action.resolution,
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
      onStatusAction={handleStatusAction}
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
      occurrenceBuckets={stats.data?.buckets}
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

  lines.push("", `## Errors in this incident (${issues.length})`);
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
        `   - Error ID: ${issue.id}`,
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
    const prUrls = (result?.prs ?? (result?.pr ? [result.pr] : []))
      .map((pr) => pr.url)
      .filter((url): url is string => Boolean(url));
    if (prUrls.length > 0) {
      lines.push("", prUrls.length === 1 ? `### Existing PR` : `### Existing PRs`, ...prUrls);
    }
  }

  lines.push(
    "",
    "## Task",
    `1. Query the Superlog MCP for traces, logs, and metrics around \`${incident.lastSeen}\` for service \`${incident.service ?? "(see above)"}\` and project \`${incident.projectId}\`. Pull representative samples for each error ID above.`,
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
  className = "",
}: {
  incident: Incident;
  issues: Issue[];
  agentRun: AgentRun | null;
  className?: string;
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
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-fg transition-colors hover:border-border-strong ${className}`}
      title="Copy a ready-to-paste prompt that briefs an agent on this incident and points it at the Superlog MCP."
    >
      {error ? (
        <span className="grid h-3.5 w-3.5 place-items-center text-[10px] leading-none" aria-hidden>
          !
        </span>
      ) : copied ? (
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} aria-hidden />
      ) : (
        <HugeiconsIcon icon={ClipboardCopyIcon} size={14} aria-hidden />
      )}
      {error ? "Copy failed" : copied ? "Copied" : "Copy agent prompt"}
    </button>
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
    <div className="mt-1 font-sans text-[11px] tabular-nums text-subtle" title="Activity failed">
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
        className="mt-1 font-sans text-[11px] tabular-nums text-subtle"
        title="No user.id attribute on this incident's events"
      >
        — users
      </div>
    );
  }
  const label = capped ? `${count.toLocaleString()}+` : count.toLocaleString();
  return (
    <div className="mt-1 font-sans text-[11px] tabular-nums text-subtle">
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
      className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 whitespace-nowrap pb-0.5 font-sans text-[9px] leading-none tabular-nums"
      style={{ color: "var(--color-accent)" }}
      aria-hidden
    >
      {value.toLocaleString()}
    </span>
  );
}

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
                <span className="font-sans text-[11px] text-muted">Episode #{ep.seq}</span>
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
  onStatusAction,
  onRestartAgentRun,
  onRetryPrDelivery,
  onDecideProposal,
  updateIncidentError = null,
  decidingProposal,
  updatingIncident,
  restartingAgentRun = false,
  retryingPrDelivery = false,
  summaryTelemetry,
  occurrenceBuckets,
  pullRequests,
  readOnly = false,
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
  onStatusAction: (action: IncidentStatusAction) => void;
  onRestartAgentRun?: () => void;
  onRetryPrDelivery?: () => void;
  onDecideProposal?: (proposalId: string, decision: "confirm" | "dismiss") => void;
  updateIncidentError?: Error | null;
  decidingProposal?: boolean;
  updatingIncident: boolean;
  restartingAgentRun?: boolean;
  retryingPrDelivery?: boolean;
  /** Telemetry widgets the agent quoted in its summary, rendered inside the Summary section. */
  summaryTelemetry?: ReactNode;
  occurrenceBuckets?: { day: string; count: number }[];
  /** Preloaded PRs for read-model consumers that cannot call product APIs. */
  pullRequests?: IncidentPullRequest[];
  /** Render the canonical incident UI without controls that mutate customer data. */
  readOnly?: boolean;
}) {
  const [detailTab, setDetailTab] = useState<IncidentDetailTab>("activity");
  const access = getIncidentDetailAccess(readOnly);
  // A run paused on `ask_human` stores its question on the run result, not as an
  // incident event — surface it as the closing node of the Activity timeline.
  const awaitingQuestion =
    agentRun?.state === "awaiting_human" ? (agentRun.result?.question ?? null) : null;
  const statusActions = getIncidentStatusActions(incident.status);
  const problemResolvedAction =
    statusActions.find((action) => action.label === "Problem resolved") ?? null;
  const notAnIssueAction = statusActions.find((action) => action.label === "Not an issue") ?? null;
  const otherStatusActions = statusActions.filter(
    (action) => action.label !== "Problem resolved" && action.label !== "Not an issue",
  );
  const detailMeta = buildIncidentDetailMeta({
    incident,
    agentRunState: agentRun?.state ?? null,
    pendingRecovery: !!pendingResolutionProposal,
  });
  const outOfCredits = !agentRun && incident.autoInvestigateBlockedReason === "no_credits";
  const sidebarSummary =
    incident.agentSummary ??
    agentRun?.result?.summary ??
    "No investigation summary has been recorded yet.";
  const triggeringIssue = issues.reduce<Issue | null>((earliest, issue) => {
    if (!earliest) return issue;
    return Date.parse(issue.firstSeen) < Date.parse(earliest.firstSeen) ? issue : earliest;
  }, null);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg text-fg">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg px-5 py-3">
        <span className="text-[13px] text-muted">Incidents</span>
        <span className="text-subtle">›</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{incident.title}</span>
        <div className="flex shrink-0 items-center gap-3">
          {access.canUpdateStatus && notAnIssueAction && (
            <Btn
              variant={notAnIssueAction.variant}
              size="sm"
              onClick={() => onStatusAction(notAnIssueAction)}
              loading={updatingIncident}
            >
              {notAnIssueAction.label}
            </Btn>
          )}
          {access.canUpdateStatus && problemResolvedAction && (
            <Btn
              variant={problemResolvedAction.variant}
              size="sm"
              onClick={() => onStatusAction(problemResolvedAction)}
              loading={updatingIncident}
            >
              {problemResolvedAction.label}
            </Btn>
          )}
          <button
            onClick={onClose}
            className="text-muted transition-colors hover:text-fg"
            aria-label="close"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[390px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col border-b border-border bg-bg lg:border-b-0 lg:border-r">
          <div className="px-7 pb-7 pt-7">
            <div className="font-sans text-[11px] text-subtle">#{incident.codename}</div>
            <h2 className="mt-2 break-words text-[20px] font-semibold leading-[1.1] tracking-tight text-fg">
              {incident.title}
            </h2>
            <p className="mt-4 break-words text-[12px] leading-5 text-muted">{sidebarSummary}</p>

            <div className="mt-7 grid gap-3.5">
              {/* "Agent run" stays last; Linked issues slots in where Findings used to be. */}
              <IncidentSidebarMetaRows rows={detailMeta.slice(0, -1)} />
              <LinkedIssuesMetaRow issues={issues} onViewIssue={onViewIssue} />
              <IncidentSidebarMetaRows rows={detailMeta.slice(-1)} />
            </div>

            <div className="mt-7 grid gap-2">
              <CopyAgentPromptButton
                incident={incident}
                issues={issues}
                agentRun={agentRun}
                className="w-full justify-center"
              />
              {access.canSubmitFeedback && (
                <FeedbackTrigger
                  kind="incident"
                  refId={incident.id}
                  projectId={incident.projectId}
                  className="w-full justify-center"
                />
              )}
              {access.canUpdateStatus &&
                otherStatusActions.map((action) => (
                  <Btn
                    key={action.label}
                    variant={action.variant}
                    size="sm"
                    onClick={() => onStatusAction(action)}
                    loading={updatingIncident}
                    className="w-full justify-center"
                  >
                    {action.label}
                  </Btn>
                ))}
            </div>
            {updateIncidentError && (
              <p className="mt-3 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                Status update failed: {String(updateIncidentError)}
              </p>
            )}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col bg-bg">
          <IncidentDetailTabs active={detailTab} onChange={setDetailTab} />

          <IncidentDetailScrollArea>
            {detailTab === "activity" && (
              <div className="space-y-8">
                {outOfCredits && <OutOfCreditsBanner />}
                <div className="space-y-3">
                  {eventsLoading && <p className="text-[12px] text-muted">loading…</p>}
                  {eventsError && (
                    <p className="text-[12px] text-danger">failed: {String(eventsError)}</p>
                  )}
                  {!eventsLoading &&
                    !eventsError &&
                    events.length === 0 &&
                    !outOfCredits &&
                    !awaitingQuestion &&
                    !triggeringIssue && <p className="text-[12px] text-muted">No activity yet.</p>}
                  <IncidentActivityFeed
                    events={events}
                    triggeringIssue={
                      triggeringIssue
                        ? { issueId: triggeringIssue.id, createdAt: incident.firstSeen }
                        : null
                    }
                    awaiting={
                      awaitingQuestion
                        ? {
                            question: awaitingQuestion,
                            ctx: {
                              repoUrl: agentRun?.selectedRepoUrl ?? null,
                              baseBranch: agentRun?.selectedBaseBranch ?? null,
                            },
                          }
                        : null
                    }
                    renderIssueCard={(issueId, options) => {
                      const issue = issues.find((i) => i.id === issueId);
                      if (!issue) return null;
                      return (
                        <div className="rounded-lg border border-border bg-surface px-3 py-2">
                          <IssueCard
                            issue={issue}
                            onViewIssue={onViewIssue}
                            occurrenceBuckets={
                              options?.showOccurrences ? occurrenceBuckets : undefined
                            }
                          />
                        </div>
                      );
                    }}
                  />
                </div>
              </div>
            )}

            {detailTab === "findings" && (
              <div className="space-y-8">
                {alertEpisodes.length > 0 && (
                  <div className="space-y-3">
                    <SectionHeading>Triggered by</SectionHeading>
                    <TriggeredByAlertEpisodes episodes={alertEpisodes} />
                  </div>
                )}

                {pendingResolutionProposal && (
                  <ResolutionProposalBanner
                    proposal={pendingResolutionProposal}
                    onConfirm={
                      onDecideProposal
                        ? () => onDecideProposal(pendingResolutionProposal.id, "confirm")
                        : undefined
                    }
                    onDismiss={
                      onDecideProposal
                        ? () => onDecideProposal(pendingResolutionProposal.id, "dismiss")
                        : undefined
                    }
                    deciding={!!decidingProposal}
                    readOnly={!access.canDecideResolutionProposal}
                  />
                )}

                {outOfCredits && <OutOfCreditsBanner />}

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
                  summaryTelemetry={summaryTelemetry}
                />
              </div>
            )}

            {detailTab === "pr" && (
              <IncidentPullRequestPanel
                projectId={incident.projectId}
                incidentId={incident.id}
                pullRequests={pullRequests}
                readOnly={!access.canMergePullRequest}
              />
            )}
          </IncidentDetailScrollArea>

          {detailTab === "activity" && access.canChat && (
            <IncidentChatComposer
              projectId={incident.projectId}
              incidentId={incident.id}
              hasAgentRun={!!agentRun}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Talk to the investigation from the incident page — the web equivalent of
// replying in the incident's Slack thread or commenting on its PR. Messages
// flow into the same durable agent session (ask for PR changes, explain how to
// address the issue, correct course); the agent's reply lands in the activity
// feed above.
function IncidentChatComposer({
  projectId,
  incidentId,
  hasAgentRun,
}: {
  projectId: string;
  incidentId: string;
  hasAgentRun: boolean;
}) {
  const send = useSendIncidentChatMessage(projectId, incidentId);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false);
  // The dedupe id for the current draft. Minted once and reused across retries
  // of the *same* unsent message, so a resend after a failed response (the
  // first request may have reached the server) dedupes instead of enqueuing
  // twice. Cleared on success and whenever the draft is edited (a new message).
  const pendingIdRef = useRef<string | null>(null);
  const disabled = !hasAgentRun;

  function onDraftChange(value: string) {
    setText(value);
    pendingIdRef.current = null;
    if (justSent) setJustSent(false);
    if (error) setError(null);
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || send.isPending || disabled) return;
    setError(null);
    if (!pendingIdRef.current) pendingIdRef.current = crypto.randomUUID();
    send.mutate(
      { text: trimmed, messageId: pendingIdRef.current },
      {
        onSuccess: () => {
          setText("");
          pendingIdRef.current = null;
          setJustSent(true);
        },
        onError: (err) => setError(incidentChatErrorMessage(err)),
      },
    );
  }

  return (
    <div className="shrink-0 bg-bg px-6 py-4 lg:px-8">
      <div
        className={`relative rounded-lg border border-border bg-surface-2 transition-colors focus-within:border-border-strong ${
          disabled ? "opacity-40" : ""
        }`}
      >
        <textarea
          value={text}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={
            disabled
              ? "No investigation to talk to yet — start one from the Findings tab."
              : "Reply to the investigation — request PR changes, explain the issue, add context…"
          }
          className="min-h-[124px] w-full resize-none bg-transparent px-3 pb-12 pt-2 text-[14px] leading-relaxed text-fg placeholder:text-subtle focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="absolute bottom-3 right-3 flex items-center gap-2.5">
          {!disabled && (
            <span className="text-[10px] leading-[14px] text-subtle">
              Shift Enter for a new line
            </span>
          )}
          <Btn
            variant="primary"
            size="md"
            onClick={submit}
            loading={send.isPending}
            disabled={disabled || !text.trim()}
          >
            Send
          </Btn>
        </div>
      </div>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      {!error && justSent && (
        <p className="mt-2 text-[12px] text-muted">
          Delivered to the investigation — the reply will appear in the feed above.
        </p>
      )}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function IncidentSidebarMetaRows({ rows }: { rows: IncidentMetaRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <div
          key={`${row.label}-${row.value}`}
          className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-3 text-[13px]"
        >
          <div className="text-muted">{row.label}</div>
          <div
            className={`flex min-w-0 items-center gap-2 ${row.tone === "danger" ? "text-danger" : "text-fg"}`}
          >
            <IncidentMetaIcon row={row} />
            <span className="min-w-0 break-words" title={row.title}>
              {row.value}
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

// Sidebar property for the incident's linked issues. The value reads as plain
// "N issues" text like the other meta rows, but clicking it opens a popover
// listing the issues (same cards as the activity feed).
function LinkedIssuesMetaRow({
  issues,
  onViewIssue,
}: {
  issues: Issue[];
  onViewIssue: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  const count = issues.length;
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-3 text-[13px]">
      <div className="text-muted">Linked errors</div>
      <div ref={ref} className="relative flex min-w-0 items-center gap-[5px] text-fg">
        <ArrowUpRightIcon />
        {count === 0 ? (
          <span className="text-muted">none</span>
        ) : (
          <>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="text-fg transition-colors hover:text-muted"
            >
              {count} error{count === 1 ? "" : "s"}
            </button>
            {open && (
              <div className="absolute left-0 top-full z-20 mt-1.5 w-80 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)]">
                {issues.map((issue) => (
                  <div
                    key={issue.id}
                    className="rounded-md px-2.5 py-2 transition-colors hover:bg-surface-2"
                  >
                    <IssueCard
                      issue={issue}
                      onViewIssue={(id) => {
                        setOpen(false);
                        onViewIssue(id);
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-muted"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

function IncidentMetaIcon({ row }: { row: IncidentMetaRow }) {
  if (row.kind === "priority") return <PriorityBars />;
  if (row.kind === "status") return <StatusDot />;
  if (row.kind === "environment") return <EnvironmentDot />;
  if (row.kind === "findings") return <FindingsDot />;
  if (row.kind === "agent") return <AgentDot tone={row.tone} />;
  return null;
}

function PriorityBars() {
  return (
    <span className="flex h-4 w-4 shrink-0 items-end gap-[2px] text-muted" aria-hidden>
      <span className="h-1.5 w-[3px] bg-current" />
      <span className="h-2.5 w-[3px] bg-current" />
      <span className="h-4 w-[3px] bg-current" />
    </span>
  );
}

function StatusDot() {
  return <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />;
}

function EnvironmentDot() {
  return <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden />;
}

function FindingsDot() {
  return <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden />;
}

function AgentDot({ tone }: { tone?: "danger" }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${tone === "danger" ? "bg-danger" : "bg-accent"}`}
      aria-hidden
    />
  );
}

type IncidentDetailTab = "activity" | "findings" | "pr";

function IncidentDetailTabs({
  active,
  onChange,
}: {
  active: IncidentDetailTab;
  onChange: (tab: IncidentDetailTab) => void;
}) {
  return (
    <div className="bg-bg px-6 lg:px-8">
      <div className="flex items-center pb-3 pt-[18px]">
        <Tabs
          value={active}
          onChange={onChange}
          options={[
            { value: "activity", label: "Activity" },
            { value: "findings", label: "Findings" },
            { value: "pr", label: "PR" },
          ]}
        />
      </div>
    </div>
  );
}

export function IncidentPullRequestPanel({
  projectId,
  incidentId,
  pullRequests,
  readOnly,
}: {
  projectId: string;
  incidentId: string;
  pullRequests?: IncidentPullRequest[];
  readOnly: boolean;
}) {
  if (
    shouldUsePreloadedPullRequests({
      readOnly,
      pullRequestsProvided: pullRequests !== undefined,
    })
  ) {
    return <IncidentPullRequestView pullRequests={pullRequests ?? []} readOnly={readOnly} />;
  }
  return <ProductIncidentPullRequestPanel projectId={projectId} incidentId={incidentId} />;
}

function ProductIncidentPullRequestPanel({
  projectId,
  incidentId,
}: {
  projectId: string;
  incidentId: string;
}) {
  const prs = useIncidentPullRequests(projectId, incidentId);
  const mergePr = useMergeIncidentPullRequest(projectId, incidentId);

  if (prs.isLoading) {
    return <p className="text-[12px] text-muted">Loading PR…</p>;
  }
  if (prs.error) {
    return <p className="text-[12px] text-danger">Failed to load PR: {String(prs.error)}</p>;
  }
  return (
    <IncidentPullRequestView
      pullRequests={prs.data ?? []}
      readOnly={false}
      merging={mergePr.isPending}
      mergeError={mergePr.error}
      onMerge={(prId) => mergePr.mutate({ prId })}
    />
  );
}

export function IncidentPullRequestView({
  pullRequests,
  readOnly,
  merging = false,
  mergeError = null,
  onMerge,
}: {
  pullRequests: IncidentPullRequest[];
  readOnly: boolean;
  merging?: boolean;
  mergeError?: Error | null;
  onMerge?: (prId: string) => void;
}) {
  const [selectedPrId, setSelectedPrId] = useState<string | null>(null);

  const selectedPr = pullRequests.find((pr) => pr.id === selectedPrId) ?? pullRequests[0] ?? null;

  useEffect(() => {
    if (!pullRequests.length) {
      setSelectedPrId(null);
      return;
    }
    if (!selectedPrId || !pullRequests.some((pr) => pr.id === selectedPrId)) {
      setSelectedPrId(pullRequests[0]!.id);
    }
  }, [pullRequests, selectedPrId]);

  if (pullRequests.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface p-4">
        <p className="text-[12px] text-muted">No PR has been opened for this incident.</p>
      </div>
    );
  }
  if (!selectedPr) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
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
          {!readOnly && selectedPr.state === "open" && onMerge && (
            <Btn
              size="sm"
              variant="primary"
              loading={merging}
              onClick={() => onMerge(selectedPr.id)}
            >
              Merge PR
            </Btn>
          )}
        </div>
      </div>

      {pullRequests.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {pullRequests.map((pr) => (
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

      {mergeError && (
        <p className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          Merge failed: {String(mergeError)}
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
  summaryTelemetry,
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
  summaryTelemetry?: ReactNode;
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
          {summaryTelemetry ?? <IncidentSummaryTelemetry events={events} />}
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
          <div className="flex items-center gap-2">
            <SectionHeading>Question</SectionHeading>
            <Chip tone="warning">Awaiting you</Chip>
          </div>
          <EvidenceMarkdown text={result.question} ctx={linkCtx} />
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
        {(agentRun.selectedRepoFullName || agentRun.selectedBaseBranch) && (
          <AgentRunMeta agentRun={agentRun} />
        )}
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
          <ul className="space-y-1 font-sans text-[11px]">
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
  readOnly = false,
}: {
  proposal: PendingResolutionProposal;
  onConfirm?: () => void;
  onDismiss?: () => void;
  deciding?: boolean;
  readOnly?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <div className="mb-3 flex items-center gap-2 text-[11px] font-medium">
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
      {!readOnly && onConfirm && onDismiss && (
        <div className="flex items-center justify-end gap-2">
          <Btn variant="ghost" size="sm" onClick={onDismiss} loading={deciding}>
            Dismiss
          </Btn>
          <Btn variant="primary" size="sm" onClick={onConfirm} loading={deciding}>
            Confirm resolution
          </Btn>
        </div>
      )}
    </div>
  );
}

// Top-level incident timeline. Lives outside InvestigationView because an
// incident has lifecycle events (manual resolves, autorecovery proposal
// confirmations, recurrence reopens) that aren't tied to any
// investigation — and the view shouldn't disappear just because no agent
// has run yet.
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
  // Multi-PR runs list every PR in `prs`; older runs only have the single `pr`.
  const prs = result.prs ?? (result.pr ? [result.pr] : []);
  const ticket = result.linearTicket ?? null;
  if (prs.length === 0 && !ticket) return null;
  return (
    <div className="space-y-3">
      <SectionHeading>Deliverables</SectionHeading>
      <div className="flex flex-wrap gap-2">
        {prs.map((pr) => (
          <Fragment key={pr.branchName}>
            {pr.openStatus === "opened" && pr.url && (
              <a href={pr.url} target="_blank" rel="noreferrer" className="text-[12px]">
                <Chip tone="success" dot>
                  PR opened · {pr.selectedRepoFullName}
                </Chip>
              </a>
            )}
            {pr.openStatus === "pending" && (
              <Chip tone="neutral" dot>
                PR pending · {pr.selectedRepoFullName}
              </Chip>
            )}
            {pr.validationPassed === false && (
              <Chip tone="danger" dot>
                Patch validation failed
              </Chip>
            )}
          </Fragment>
        ))}
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
  if (state === "awaiting_events") {
    return (
      <Chip tone="warning" dot>
        awaiting events
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
  return <span className="font-sans text-[11px] text-subtle">{parts.join(" | ")}</span>;
}

function IssueStatusChip({ issue }: { issue: Issue }) {
  if (issue.status === "silenced") return <Chip tone="neutral">silenced</Chip>;
  if (issue.status === "resolved") return <Chip tone="success">resolved</Chip>;
  if (issue.status === "under_observation") {
    const trigger = issue.escalationTrigger;
    const label =
      trigger?.kind === "rate"
        ? `observing · >${trigger.perMinute}/min`
        : trigger?.kind === "count"
          ? `observing · +${trigger.count} events`
          : "observing";
    return <Chip tone="warning">{label}</Chip>;
  }
  return null;
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
      <p className="mt-0.5 font-sans text-[12px] text-fg">{value}</p>
    </div>
  );
}

function MetaInline({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <SectionHeader>{label}</SectionHeader>
      <span className="font-sans text-[12px] text-fg">{value}</span>
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
    <span className={`font-sans text-[11px] tabular-nums ${toneClass}`}>
      confidence {clamped}/10
    </span>
  );
}

// One issue row — used in the sidebar's linked-issues popover and embedded in
// activity-feed entries that reference an issue (recurrence, reopen).
function IssueCard({
  issue,
  onViewIssue,
  occurrenceBuckets,
}: {
  issue: Issue;
  onViewIssue: (id: string) => void;
  occurrenceBuckets?: { day: string; count: number }[];
}) {
  return (
    <button
      onClick={() => onViewIssue(issue.id)}
      className="block w-full min-w-0 text-left transition-colors hover:text-muted"
    >
      <div
        className={
          occurrenceBuckets && occurrenceBuckets.length > 0
            ? "flex flex-col gap-3 sm:flex-row sm:gap-4"
            : undefined
        }
      >
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-2">
            <KindChip issue={issue} />
            <span className="font-sans text-[11px] text-muted">{issue.exceptionType}</span>
            <span className="font-sans text-[11px] tabular-nums text-subtle">
              {fmtCount(issue.eventCount)} event{issue.eventCount !== 1 ? "s" : ""}
            </span>
          </div>
          <p className="truncate text-[12px] text-fg">{issue.message ?? issue.title}</p>
          {occurrenceBuckets && occurrenceBuckets.length > 0 && (
            <p className="mt-3 text-[10px] text-subtle">
              First {fmtRelative(issue.firstSeen)} · Last {fmtRelative(issue.lastSeen)}
            </p>
          )}
        </div>
        {occurrenceBuckets && occurrenceBuckets.length > 0 && (
          <IssueOccurrenceGraph buckets={occurrenceBuckets} />
        )}
      </div>
    </button>
  );
}

function formatOccurrenceDate(day: string) {
  const [year = Number.NaN, month = Number.NaN, date = Number.NaN] = day
    .split("-")
    .map(Number);
  const parsed =
    Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(date)
      ? new Date(year, month - 1, date)
      : new Date(day);
  if (Number.isNaN(parsed.getTime())) return day;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

function IssueOccurrenceGraph({ buckets }: { buckets: { day: string; count: number }[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  return (
    <div className="border-t border-border pt-2.5 sm:w-44 sm:flex-none sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
      <div className="flex items-center justify-between text-[10px] text-subtle">
        <span>Occurrences · last {buckets.length} days</span>
        <span className="font-sans tabular-nums text-fg">{total.toLocaleString()}</span>
      </div>
      <div
        className="mt-2 flex h-16 items-end gap-1 border-b border-border"
        role="img"
        aria-label={`${total.toLocaleString()} error occurrences over the last ${buckets.length} days`}
      >
        {buckets.map((bucket) => {
          const occurrenceLabel = `${formatOccurrenceDate(bucket.day)} · ${bucket.count.toLocaleString()} occurrence${bucket.count === 1 ? "" : "s"}`;
          return (
            <span key={bucket.day} className="group relative flex h-full min-w-0 flex-1 items-end">
              <span
                className="min-h-px w-full rounded-t-[2px] bg-accent"
                style={{
                  height: `max(1px, ${(bucket.count / max) * 100}%)`,
                  opacity: bucket.count === 0 ? 0.12 : 0.75,
                }}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-3 px-2 py-1 font-sans text-[10px] text-fg opacity-0 shadow-lift-sm transition-opacity group-hover:opacity-100"
              >
                {occurrenceLabel}
              </span>
            </span>
          );
        })}
      </div>
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

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
