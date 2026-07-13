import { useState } from "react";
import { useMcpStatus, useMe } from "../api.ts";
import { McpInstallDialog } from "./McpInstallDialog.tsx";
import { TerminalIcon } from "./icons.tsx";
import { isMcpPillDismissed, rememberMcpPillDismiss, shouldShowMcpPill } from "./mcpPill.ts";

// Floating bottom-right reminder for users who skipped the MCP install during
// onboarding. Mounted app-wide; auto-hides once the MCP OAuth flow completes.
export function McpInstallPill() {
  const me = useMe();
  const projectId = me.data?.project?.id;
  const mcp = useMcpStatus(projectId);
  const [dismissed, setDismissed] = useState(isMcpPillDismissed);
  const [open, setOpen] = useState(false);

  if (!shouldShowMcpPill({ projectId, connected: mcp.data?.connected, dismissed })) {
    return null;
  }

  return (
    <>
      <div className="fixed bottom-5 right-5 z-40 flex items-center overflow-hidden rounded-full border border-border-strong bg-surface shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 py-2 pl-4 pr-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
        >
          <TerminalIcon size={14} className="text-accent" />
          Install the MCP server
        </button>
        <button
          type="button"
          onClick={() => {
            rememberMcpPillDismiss();
            setDismissed(true);
          }}
          aria-label="Dismiss"
          className="grid h-9 w-8 place-items-center border-l border-border text-muted transition-colors hover:text-fg"
        >
          <svg
            viewBox="0 0 12 12"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m3 3 6 6m0-6-6 6" />
          </svg>
        </button>
      </div>
      {open && <McpInstallDialog onClose={() => setOpen(false)} />}
    </>
  );
}
