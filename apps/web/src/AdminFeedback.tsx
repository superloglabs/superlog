import { useState } from "react";
import { AdminSubnav } from "./Evals.tsx";
import {
  type FeedbackRow,
  type FeedbackStatus,
  useAdminFeedback,
  useUpdateFeedbackStatus,
} from "./api.ts";
import { useSession } from "./auth-client.ts";
import { Btn, Chip } from "./design/ui.tsx";

// Admin inbox for everything submitted through the in-product dialog,
// the public PR-link page, the GitHub PR-comment webhook, and the Slack
// "Give feedback" button. All sources funnel into the same table, so
// this view is intentionally a single chronological list — kind/source
// chips on each row tell you where it came from.
export function AdminFeedback() {
  const { data: session, isPending } = useSession();
  const [statusFilter, setStatusFilter] = useState<"all" | FeedbackStatus>("new");
  const q = useAdminFeedback(!!session, statusFilter);

  if (isPending) {
    return <div className="py-12 text-center text-sm text-muted">Loading…</div>;
  }
  if (q.error && (q.error as Error).message.startsWith("403")) {
    return <div className="py-12 text-center text-sm text-muted">Not found.</div>;
  }

  return (
    <div className="space-y-6">
      <AdminSubnav />
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-medium tracking-tight">Feedback</h1>
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle">
          dialog · pr · slack
        </span>
      </div>
      <div className="flex items-center gap-2">
        {(["new", "triaged", "closed", "all"] as const).map((s) => (
          <FilterTab key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
            {s}
          </FilterTab>
        ))}
      </div>
      {q.isLoading && <div className="py-12 text-center text-sm text-muted">Loading…</div>}
      {q.error && !(q.error as Error).message.startsWith("403") && (
        <div className="py-12 text-center text-sm text-muted">
          Failed to load: {(q.error as Error).message}
        </div>
      )}
      {q.data && (
        <div className="space-y-3">
          {q.data.rows.length === 0 ? (
            <div className="border border-border bg-surface-2 p-6 text-center text-[13px] text-muted">
              No feedback in this bucket.
            </div>
          ) : (
            q.data.rows.map((row) => <FeedbackCard key={row.id} row={row} />)
          )}
        </div>
      )}
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "border border-border bg-surface-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-fg"
          : "border border-transparent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-muted hover:text-fg"
      }
    >
      {children}
    </button>
  );
}

function FeedbackCard({ row }: { row: FeedbackRow }) {
  const updateStatus = useUpdateFeedbackStatus();
  return (
    <div className="space-y-3 border border-border bg-surface-2 p-4" data-feedback-id={row.id}>
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={row.kind} />
        <SourceChip source={row.source} />
        <StatusChip status={row.status} />
        <span className="ml-auto font-mono text-[11px] text-subtle">{fmtTime(row.createdAt)}</span>
      </div>
      <div className="whitespace-pre-wrap text-[13px] text-fg">{row.body}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-subtle">
        <span>{describeAuthor(row)}</span>
        <span>{describeRef(row)}</span>
        {row.triagedByEmail && row.triagedAt && (
          <span>
            triaged by {row.triagedByEmail} · {fmtTime(row.triagedAt)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        {row.status !== "triaged" && (
          <Btn
            size="sm"
            variant="secondary"
            loading={updateStatus.isPending}
            onClick={() => updateStatus.mutate({ id: row.id, status: "triaged" })}
          >
            Mark triaged
          </Btn>
        )}
        {row.status !== "closed" && (
          <Btn
            size="sm"
            variant="ghost"
            loading={updateStatus.isPending}
            onClick={() => updateStatus.mutate({ id: row.id, status: "closed" })}
          >
            Close
          </Btn>
        )}
        {row.status !== "new" && (
          <Btn
            size="sm"
            variant="ghost"
            loading={updateStatus.isPending}
            onClick={() => updateStatus.mutate({ id: row.id, status: "new" })}
          >
            Reopen
          </Btn>
        )}
        {row.authorExternal?.githubCommentUrl && (
          <a
            href={row.authorExternal.githubCommentUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted hover:text-fg"
          >
            Open on GitHub →
          </a>
        )}
      </div>
    </div>
  );
}

function KindChip({ kind }: { kind: FeedbackRow["kind"] }) {
  return <Chip tone="neutral">{kind}</Chip>;
}

function SourceChip({ source }: { source: FeedbackRow["source"] }) {
  const label =
    source === "dialog"
      ? "in-app"
      : source === "pr_link"
        ? "pr link"
        : source === "pr_comment"
          ? "pr comment"
          : source === "slack_button"
            ? "slack"
            : source;
  return <Chip tone="muted">{label}</Chip>;
}

function StatusChip({ status }: { status: FeedbackRow["status"] }) {
  const tone = status === "new" ? "warning" : status === "triaged" ? "accent" : "muted";
  return (
    <Chip tone={tone} dot>
      {status}
    </Chip>
  );
}

function describeAuthor(row: FeedbackRow): string {
  if (row.authorEmail) return row.authorEmail;
  if (row.authorExternal?.githubLogin) return `@${row.authorExternal.githubLogin} (github)`;
  if (row.authorExternal?.slackUserId) return `<@${row.authorExternal.slackUserId}> (slack)`;
  return "anonymous";
}

function describeRef(row: FeedbackRow): string {
  if (row.kind === "pr") {
    return row.refRepo ? `${row.refRepo} (pr)` : `pr ${row.refId}`;
  }
  return `${row.kind} ${row.refId.slice(0, 8)}…`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
