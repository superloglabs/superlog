import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button, Card, I, Wordmark } from "./atoms.tsx";
import type { OnboardingResult } from "./types.ts";

type Todo = {
  id: "install" | "deploy" | "github" | "slack" | "mcp";
  icon: ReactNode;
  title: string;
  desc: string;
  cta: string;
  variant: "primary" | "secondary";
  mins: number;
  meta?: string;
};

function TopNav({ user = "ash" }: { user?: string }) {
  const tabs = ["Overview", "Issues", "PRs", "Traces", "Logs", "Settings"];
  return (
    <header
      style={{
        height: 52,
        display: "flex",
        alignItems: "center",
        gap: 24,
        padding: "0 24px",
        borderBottom: "1px solid var(--sl-line)",
        background: "var(--sl-bg)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <Wordmark />
      <span style={{ width: 1, height: 18, background: "var(--sl-line-2)" }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          color: "var(--sl-fg-2)",
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            background: "#485ae2",
            display: "inline-block",
          }}
        />
        acme
      </span>
      <nav style={{ display: "flex", gap: 4, marginLeft: 16 }}>
        {tabs.map((t, i) => (
          <button
            key={t}
            type="button"
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              fontSize: 13,
              color: i === 0 ? "var(--sl-fg)" : "var(--sl-fg-3)",
              background: i === 0 ? "rgba(255,255,255,0.05)" : "transparent",
              border: 0,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      <span style={{ flex: 1 }} />
      <span className="sl-onb-tiny" style={{ color: "var(--sl-fg-4)" }}>
        ⌘K
      </span>
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: "linear-gradient(135deg,#8C98F0,#41d195)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          fontWeight: 600,
          color: "#000",
        }}
      >
        {user[0]?.toUpperCase()}
      </span>
    </header>
  );
}

function buildTodos(state: Partial<OnboardingResult>): Todo[] {
  const todos: Todo[] = [];
  // Install + Deploy are part of onboarding — only surface them on the
  // dashboard if the user explicitly skipped, since nothing else flows
  // until the SDK is in the codebase and shipped.
  if (state.installSkipped) {
    todos.push({
      id: "install",
      icon: I.terminal(18),
      title: "Install Superlog",
      desc: "Drop the install prompt into your agent so it can wire up the SDK and instrument your code.",
      cta: "Open install prompt",
      variant: "primary",
      mins: 2,
      meta: "npx skills add",
    });
  }
  if (state.deploySkipped || state.deploy?.shipped === false) {
    todos.push({
      id: "deploy",
      icon: I.bolt(16),
      title: "Deploy & set env vars",
      desc: "Drop SUPERLOG_API_KEY into your runtime. Vercel, Railway, Fly, AWS — we have a one-liner.",
      cta: "View deploy guide",
      variant: "primary",
      mins: 3,
      meta: "SUPERLOG_API_KEY=sk_live_…",
    });
  }
  if (state.githubSkipped || !state.github?.connected) {
    todos.push({
      id: "github",
      icon: I.github(18),
      title: "Let us fix your bugs",
      mins: 1,
      desc: "Connect your GitHub so our agent can investigate bugs and submit PRs.",
      cta: "Connect GitHub",
      variant: "primary",
      meta: "github.com/apps/superlog",
    });
  }
  if (state.slackSkipped || !state.slack?.connected) {
    todos.push({
      id: "slack",
      icon: I.slack(18),
      title: "Get PRs with fixes in your Slack",
      mins: 1,
      desc: "Connect Superlog to Slack to get helpful incident summaries and fixes in your #ops channel.",
      cta: "Connect Slack",
      variant: "primary",
      meta: "chat:write · channels:read",
    });
  }
  todos.push({
    id: "mcp",
    icon: I.terminal(16),
    title: "Install the MCP server",
    desc: "Hook Superlog into your editor. Your agent can query traces, logs, and incidents directly while it codes.",
    cta: "Copy install command",
    variant: "secondary",
    mins: 1,
    meta: "npx superlog-mcp install",
  });
  return todos;
}

function TodoCard({
  todo,
  onAction,
  onSkip,
}: {
  todo: Todo;
  onAction: () => void;
  onSkip: () => void;
}) {
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "32px 36px",
          background: "var(--sl-surface)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
          <span
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "rgba(72,90,226,0.1)",
              border: "1px solid var(--sl-indigo-line)",
              color: "var(--sl-indigo-2)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {todo.icon}
          </span>
          <div style={{ flex: 1 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: "-0.02em",
              }}
            >
              {todo.title}
            </h3>
          </div>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: "var(--sl-fg-2)",
            lineHeight: 1.55,
            maxWidth: 580,
          }}
        >
          {todo.desc}
        </p>
      </div>
      <div
        style={{
          padding: "14px 36px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          justifyContent: "flex-end",
        }}
      >
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Mark as done
        </Button>
        <Button variant={todo.variant} size="md" onClick={onAction} rightIcon={I.arrow(13)}>
          {todo.cta}
        </Button>
      </div>
    </Card>
  );
}

function TodoCarousel({
  todos,
  done,
  onAction,
  onSkip,
}: {
  todos: Todo[];
  done: Record<string, boolean>;
  onAction: (todo: Todo) => void;
  onSkip: (todo: Todo) => void;
}) {
  const [idx, setIdx] = useState(0);
  const visible = todos.filter((t) => !done[t.id]);
  const safeIdx = Math.min(idx, Math.max(0, visible.length - 1));
  const current = visible[safeIdx];

  useEffect(() => {
    if (idx > visible.length - 1) setIdx(Math.max(0, visible.length - 1));
  }, [visible.length, idx]);

  const total = todos.length;
  const completed = todos.length - visible.length;
  const pct = Math.round((completed / total) * 100);

  if (!current) {
    return (
      <Card style={{ padding: 32, textAlign: "center" }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: "rgba(65,209,149,0.12)",
            color: "var(--sl-green)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 14,
          }}
        >
          {I.check(20)}
        </div>
        <div style={{ fontSize: 17, fontWeight: 600 }}>You're all set</div>
      </Card>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.02em",
          }}
        >
          Finish setting up Superlog
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: "var(--sl-fg-3)" }}>
            {completed} / {total}
          </span>
          <div
            style={{
              width: 120,
              height: 4,
              borderRadius: 2,
              background: "rgba(255,255,255,0.06)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: "var(--sl-indigo)",
                transition: "width 300ms ease",
              }}
            />
          </div>
        </div>
      </div>

      <div style={{ position: "relative" }}>
        <div style={{ overflow: "hidden", borderRadius: 14 }}>
          <div
            style={{
              display: "flex",
              transform: `translateX(-${safeIdx * 100}%)`,
              transition: "transform 320ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            {visible.map((t) => (
              <div key={t.id} style={{ flex: "0 0 100%", padding: "0 1px" }}>
                <TodoCard todo={t} onAction={() => onAction(t)} onSkip={() => onSkip(t)} />
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 18,
          }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            {visible.map((t, i) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setIdx(i)}
                aria-label={t.title}
                style={{
                  width: i === safeIdx ? 24 : 8,
                  height: 8,
                  borderRadius: 4,
                  background: i === safeIdx ? "var(--sl-indigo)" : "rgba(255,255,255,0.12)",
                  border: 0,
                  padding: 0,
                  cursor: "pointer",
                  transition: "all 200ms ease",
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIdx(Math.max(0, safeIdx - 1))}
              disabled={safeIdx === 0}
              leftIcon={I.arrowL(13)}
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIdx(Math.min(visible.length - 1, safeIdx + 1))}
              disabled={safeIdx === visible.length - 1}
              rightIcon={I.arrow(13)}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyDashboard() {
  const stats = [
    { t: "Errors (24h)", v: "—", s: "No data yet" },
    { t: "P95 latency", v: "—", s: "No data yet" },
    { t: "Open incidents", v: "0", s: "All quiet" },
  ];
  return (
    <div
      style={{
        marginTop: 36,
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 14,
      }}
    >
      {stats.map((s) => (
        <Card key={s.t} style={{ padding: 18 }}>
          <div className="sl-onb-tiny" style={{ marginBottom: 10 }}>
            {s.t}
          </div>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>{s.v}</div>
          <div style={{ fontSize: 11.5, color: "var(--sl-fg-4)", marginTop: 6 }}>{s.s}</div>
        </Card>
      ))}
    </div>
  );
}

// ─── MCP install dialog ────────────────────────────────────────────
type McpClient = {
  id: "claude" | "codex" | "cursor";
  label: string;
  language: "bash" | "json";
  code: string;
  hint?: string;
};

const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude",
    label: "Claude Code",
    language: "bash",
    code: "claude mcp add --transport http superlog https://api.superlog.sh/mcp",
  },
  {
    id: "codex",
    label: "Codex",
    language: "bash",
    code: `codex mcp add superlog --url https://api.superlog.sh/mcp
codex mcp login superlog`,
  },
  {
    id: "cursor",
    label: "Cursor",
    language: "json",
    hint: "Add to ~/.cursor/mcp.json or your project's .cursor/mcp.json.",
    code: `{
  "mcpServers": {
    "superlog": {
      "url": "https://api.superlog.sh/mcp"
    }
  }
}`,
  },
];

function McpInstallDialog({ onClose }: { onClose: () => void }) {
  const [clientId, setClientId] = useState<McpClient["id"]>("claude");
  const [copied, setCopied] = useState(false);
  // MCP_CLIENTS is a non-empty literal, so the lookup is always defined.
  const active = (MCP_CLIENTS.find((c) => c.id === clientId) ?? MCP_CLIENTS[0]) as McpClient;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = () => {
    try {
      navigator.clipboard?.writeText(active.code);
    } catch {
      // ignore
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      // biome-ignore lint/a11y/useSemanticElements: <dialog> would require .showModal() lifecycle wiring; conditional render with role="dialog" is intentional for this design demo.
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-dialog-title"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(4px)",
          border: 0,
          cursor: "default",
        }}
      />
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 640,
          background: "var(--sl-surface)",
          border: "1px solid var(--sl-line-2)",
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "18px 22px",
            borderBottom: "1px solid var(--sl-line)",
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "rgba(72,90,226,0.1)",
              border: "1px solid var(--sl-indigo-line)",
              color: "var(--sl-indigo-2)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {I.terminal(16)}
          </span>
          <div style={{ flex: 1 }}>
            <h2
              id="mcp-dialog-title"
              style={{
                margin: 0,
                fontSize: 17,
                fontWeight: 600,
                letterSpacing: "-0.01em",
              }}
            >
              Install the Superlog MCP server
            </h2>
            <div style={{ fontSize: 12, color: "var(--sl-fg-3)", marginTop: 2 }}>
              Pick your agent. First connect runs an OAuth flow in your browser.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} leftIcon={I.x(12)}>
            Close
          </Button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "12px 16px 0",
            borderBottom: "1px solid var(--sl-line)",
          }}
        >
          {MCP_CLIENTS.map((c) => {
            const isActive = c.id === active.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setClientId(c.id)}
                style={{
                  padding: "8px 14px",
                  borderTopLeftRadius: 6,
                  borderTopRightRadius: 6,
                  border: 0,
                  borderBottom: `2px solid ${isActive ? "var(--sl-indigo)" : "transparent"}`,
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                  background: "transparent",
                  color: isActive ? "var(--sl-fg)" : "var(--sl-fg-3)",
                  fontFamily: "inherit",
                  marginBottom: -1,
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div style={{ padding: "18px 22px" }}>
          {active.hint && (
            <div style={{ fontSize: 12, color: "var(--sl-fg-3)", marginBottom: 10 }}>
              {active.hint}
            </div>
          )}
          <div style={{ position: "relative" }}>
            <pre
              style={{
                margin: 0,
                fontSize: 12.5,
                color: "var(--sl-fg)",
                background: "var(--sl-bg-elev)",
                border: "1px solid var(--sl-line)",
                borderRadius: 8,
                padding: "14px 16px",
                paddingRight: 88,
                overflowX: "auto",
                whiteSpace: "pre",
                fontFamily: "inherit",
              }}
            >
              {active.code}
            </pre>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={copied ? I.check(13) : I.copy(13)}
              onClick={copy}
              style={{ position: "absolute", top: 8, right: 8 }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>

        <div
          style={{
            padding: "12px 22px",
            borderTop: "1px solid var(--sl-line)",
            fontSize: 12,
            color: "var(--sl-fg-4)",
          }}
        >
          Using a different agent? Most MCP-aware tools accept the same{" "}
          <span style={{ color: "var(--sl-fg-2)" }}>https://api.superlog.sh/mcp</span> URL.
        </div>
      </div>
    </div>
  );
}

export function Dashboard({
  onboardingState,
  onResumeOnboarding,
}: {
  onboardingState: Partial<OnboardingResult>;
  onResumeOnboarding: (which: "install" | "github" | "slack") => void;
}) {
  const todos = useMemo(() => buildTodos(onboardingState), [onboardingState]);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [mcpDialog, setMcpDialog] = useState(false);

  const handleAction = (t: Todo) => {
    if (t.id === "install" || t.id === "github" || t.id === "slack") {
      onResumeOnboarding(t.id);
    } else if (t.id === "mcp") {
      setMcpDialog(true);
    } else {
      setDone((d) => ({ ...d, [t.id]: true }));
    }
  };
  const handleSkip = (t: Todo) => setDone((d) => ({ ...d, [t.id]: true }));

  return (
    <div style={{ minHeight: "100vh", background: "var(--sl-bg)" }}>
      <TopNav />
      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 24px 80px" }}>
        <TodoCarousel todos={todos} done={done} onAction={handleAction} onSkip={handleSkip} />

        <EmptyDashboard />
      </main>
      {mcpDialog && <McpInstallDialog onClose={() => setMcpDialog(false)} />}
    </div>
  );
}
