import type { HomeBuiltinType } from "../dashboards/api.ts";
import { Btn } from "../design/ui.tsx";

const BUILTINS: Array<{
  type: HomeBuiltinType;
  label: string;
  description: string;
}> = [
  {
    type: "setup_todos",
    label: "Setup checklist",
    description: "Connection and onboarding tasks",
  },
  {
    type: "active_incidents",
    label: "Active incidents",
    description: "Recent SEV-1 and SEV-2 incidents",
  },
  {
    type: "service_map",
    label: "Service map",
    description: "Connected services and infrastructure",
  },
  {
    type: "incoming_signals",
    label: "Incoming signals",
    description: "Traces, logs, and metrics received in the last hour",
  },
  {
    type: "incident_count",
    label: "Incident count",
    description: "Open incidents grouped by severity",
  },
  {
    type: "agent_pull_requests",
    label: "Superlog pull requests",
    description: "Merged and unmerged PRs from the last 30 days",
  },
];

export function HomeCustomizePanel({
  enabledBuiltins,
  onToggleBuiltin,
  onAddWidget,
  onAddLink,
  onDone,
}: {
  enabledBuiltins: HomeBuiltinType[];
  onToggleBuiltin: (type: HomeBuiltinType, enabled: boolean) => void;
  onAddWidget: () => void;
  onAddLink: () => void;
  onDone: () => void;
}) {
  return (
    <aside
      aria-label="Customize home"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-border bg-surface shadow-2xl shadow-black/30"
    >
      <div className="flex items-start justify-between border-b border-border px-6 py-5">
        <div>
          <h2 className="text-[16px] font-semibold text-fg">Customize home</h2>
          <p className="mt-1 text-[11px] leading-4 text-muted">
            Choose the shared view your project opens to.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close customize home"
          onClick={onDone}
          className="text-[18px] leading-none text-muted hover:text-fg"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="text-[11px] font-medium text-subtle">Built-in widgets</div>
        <div className="mt-3 divide-y divide-border rounded-xl border border-border bg-bg/30 px-4">
          {BUILTINS.map((builtin) => {
            const checked = enabledBuiltins.includes(builtin.type);
            return (
              <label key={builtin.type} className="flex cursor-pointer items-center gap-3 py-4">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => onToggleBuiltin(builtin.type, event.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-fg">{builtin.label}</span>
                  <span className="mt-0.5 block text-[10px] leading-4 text-muted">
                    {builtin.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="mt-8 text-[11px] font-medium text-subtle">Add to home</div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Btn variant="secondary" onClick={onAddWidget}>
            + Add data widget
          </Btn>
          <Btn variant="secondary" onClick={onAddLink}>
            + Add link
          </Btn>
        </div>
        <p className="mt-3 text-[10px] leading-4 text-subtle">
          Agents connected through MCP can add and arrange the same widgets and links.
        </p>
      </div>

      <div className="border-t border-border p-4">
        <Btn className="w-full" onClick={onDone}>
          Done
        </Btn>
      </div>
    </aside>
  );
}
