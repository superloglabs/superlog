import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { IncidentAlertEpisode } from "../api.ts";

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

// Sidebar property linking straight to the alert(s) that raised this incident.
// For an alert-triggered incident this is the most important outbound link, so
// it sits in the always-visible sidebar rather than only in the Findings tab.
// One incident can group several episodes (and occasionally several alerts) —
// collapse to one link per distinct alert.
export function TriggeredByAlertMetaRow({ episodes }: { episodes: IncidentAlertEpisode[] }) {
  const alerts = useMemo(() => {
    const byId = new Map<string, { alertId: string; alertName: string }>();
    for (const ep of episodes) {
      if (!byId.has(ep.alertId)) {
        byId.set(ep.alertId, { alertId: ep.alertId, alertName: ep.alertName });
      }
    }
    return [...byId.values()];
  }, [episodes]);

  if (alerts.length === 0) return null;

  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-3 text-[13px]">
      <div className="text-muted">Triggered by</div>
      <div className="flex min-w-0 flex-col gap-1.5">
        {alerts.map((alert) => (
          <Link
            key={alert.alertId}
            to={`/alerts/${alert.alertId}`}
            className="flex min-w-0 items-center gap-[5px] text-fg transition-colors hover:text-muted"
          >
            <ArrowUpRightIcon />
            <span className="min-w-0 truncate">{alert.alertName}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
