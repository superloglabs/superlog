import { useEffect } from "react";
import { type CodeTab, CodeTabs } from "../CodeTabs.tsx";

const CLIENTS: CodeTab[] = [
  {
    id: "claude",
    label: "Claude Code",
    language: "bash",
    icon: "claude",
    code: "claude mcp add --transport http superlog https://api.superlog.sh/mcp",
  },
  {
    id: "codex",
    label: "Codex",
    language: "bash",
    icon: "anthropic",
    code: `codex mcp add superlog --url https://api.superlog.sh/mcp
codex mcp login superlog`,
  },
  {
    id: "cursor",
    label: "Cursor",
    language: "json",
    icon: "cursor",
    code: `{
  "mcpServers": {
    "superlog": {
      "url": "https://api.superlog.sh/mcp"
    }
  }
}`,
  },
];

/**
 * The install instructions on their own — client tabs plus the follow-up
 * notes. Rendered inline in Settings and inside {@link McpInstallDialog}.
 */
export function McpInstallPanel() {
  return (
    <div className="space-y-4">
      <CodeTabs tabs={CLIENTS} />
      <div className="space-y-1 text-[12px] text-subtle">
        <p>
          Using a different agent? Most MCP-aware tools accept the same{" "}
          <code className="font-mono text-muted">https://api.superlog.sh/mcp</code> URL.
        </p>
        <p>
          Prefer a static token over the OAuth flow? Generate a personal access token under{" "}
          <span className="text-muted">Settings → Project → MCP tokens</span> and pass it as an{" "}
          <code className="font-mono text-muted">Authorization: Bearer …</code> header.
        </p>
      </div>
    </div>
  );
}

export function McpInstallDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      // biome-ignore lint/a11y/useSemanticElements: <dialog> would require .showModal() lifecycle wiring; conditional render with role="dialog" is intentional.
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-dialog-title"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default border-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-[640px] overflow-hidden rounded-[14px] border border-border-strong bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
        <div className="flex items-start gap-3 border-b border-border px-[22px] py-[18px]">
          <div className="flex-1">
            <h2
              id="mcp-dialog-title"
              className="text-[17px] font-semibold tracking-[-0.01em] text-fg"
            >
              Install the Superlog MCP server
            </h2>
            <p className="mt-1 text-[12px] text-subtle">
              Pick your agent. First connect runs an OAuth flow in your browser.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 grid h-7 w-7 place-items-center text-muted transition-colors hover:text-fg"
            aria-label="Close"
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

        <div className="px-[22px] py-[18px]">
          <McpInstallPanel />
        </div>
      </div>
    </div>
  );
}
