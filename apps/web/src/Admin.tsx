import { useState } from "react";
import { type AdminOrgOverviewRow, useAdminOverview } from "./api";
import { useSession } from "./auth-client.ts";
import { Chip } from "./design/ui";
import { AdminSubnav } from "./Evals";

export function Admin() {
  const { data, isPending } = useSession();
  // Staff gating moved server-side: the API enforces it via STAFF_EMAILS, so
  // we just attempt the fetch and let a 403 surface as "Not found." here.
  const overview = useAdminOverview(!!data);

  if (isPending) {
    return <div className="py-12 text-center text-sm text-muted">Loading…</div>;
  }
  if (overview.error) {
    const msg = (overview.error as Error).message;
    // The API enforces staff via STAFF_EMAILS env and 403s for non-staff —
    // hide the subnav and surface as "Not found." so we don't leak the
    // existence of /admin to random signed-in users.
    if (msg.startsWith("403")) {
      return <div className="py-12 text-center text-sm text-muted">Not found.</div>;
    }
  }

  return (
    <div className="space-y-6">
      <AdminSubnav />
      {overview.isLoading && <div className="py-12 text-center text-sm text-muted">Loading…</div>}
      {overview.error && (
        <div className="py-12 text-center text-sm text-muted">
          Failed to load: {(overview.error as Error).message}
        </div>
      )}
      {overview.data && <OrgOverviewTable rows={overview.data} />}
    </div>
  );
}

export function OrgOverviewTable({ rows }: { rows: AdminOrgOverviewRow[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-medium tracking-tight">Org overview</h1>
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle">
          rolling 7d · {rows.length} orgs
        </span>
      </div>

      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left">
              <Th> </Th>
              <Th>Org</Th>
              <Th>GitHub</Th>
              <Th>Slack</Th>
              <Th>MCP server</Th>
              <Th align="right">Trace ingest</Th>
              <Th align="right">Incidents</Th>
              <Th align="right">PRs opened</Th>
              <Th align="right">PRs merged</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-muted">
                  No orgs.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <Row
                key={row.org.id}
                row={row}
                expanded={expanded.has(row.org.id)}
                onToggle={() => toggle(row.org.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[11px] text-subtle">
        Each numeric cell shows <span className="text-fg">this week</span> / prev week. Trace ingest
        counts OTLP trace batches received by Superlog. PRs counted are PRs Superlog opened on the
        org's repos, not all PRs.
      </p>
    </div>
  );
}

function Row({
  row,
  expanded,
  onToggle,
}: {
  row: AdminOrgOverviewRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-border last:border-b-0 hover:bg-surface-2/50">
        <td className="px-3 py-2.5">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? "Hide members" : "Show members"}
            className="font-mono text-[11px] text-subtle hover:text-fg"
          >
            {expanded ? "▾" : "▸"} {row.members.length}
          </button>
        </td>
        <td className="px-3 py-2.5">
          <div className="font-medium">{row.org.name}</div>
          <div className="font-mono text-[11px] text-subtle">{row.org.slug}</div>
        </td>
        <td className="px-3 py-2.5">
          <ConnectedCell connected={row.githubConnected} connectedAt={row.githubConnectedAt} />
        </td>
        <td className="px-3 py-2.5">
          <ConnectedCell connected={row.slackConnected} connectedAt={row.slackConnectedAt} />
        </td>
        <td className="px-3 py-2.5">
          <ConnectedCell connected={row.mcpConnected} connectedAt={row.mcpConnectedAt} />
        </td>
        <Cell this={row.thisWeek.traces} prev={row.prevWeek.traces} />
        <Cell this={row.thisWeek.incidents} prev={row.prevWeek.incidents} />
        <Cell this={row.thisWeek.prsOpened} prev={row.prevWeek.prsOpened} />
        <Cell this={row.thisWeek.prsMerged} prev={row.prevWeek.prsMerged} />
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-surface-2/50">
          <td />
          <td colSpan={8} className="px-3 py-2.5">
            {row.members.length === 0 ? (
              <span className="font-mono text-[11px] text-subtle">No members.</span>
            ) : (
              <ul className="space-y-1">
                {row.members.map((m) => (
                  <li key={m.email} className="flex items-baseline gap-3 font-mono text-[11px]">
                    <span className="text-fg">{m.email}</span>
                    <span className="text-subtle">joined {fmtDate(m.joinedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ConnectedCell({
  connected,
  connectedAt,
}: {
  connected: boolean;
  connectedAt: string | null;
}) {
  if (!connected) return <Chip tone="muted">—</Chip>;
  return (
    <div className="space-y-1">
      <Chip tone="success" dot>
        connected
      </Chip>
      {connectedAt && (
        <div className="font-mono text-[10px] text-subtle" title={connectedAt}>
          {fmtDate(connectedAt)}
        </div>
      )}
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function Cell({ this: thisV, prev }: { this: number; prev: number }) {
  return (
    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
      <span className={thisV > 0 ? "text-fg" : "text-subtle"}>{fmt(thisV)}</span>
      <span className="mx-1 text-subtle">/</span>
      <span className="text-subtle">{fmt(prev)}</span>
    </td>
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

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
