import { useState } from "react";
import {
  type Stats,
  useGithubInstallation,
  useMcpStatus,
  useSlackInstallation,
  useStartGithubInstall,
  useStartSlackInstall,
  useStats,
} from "../api.ts";
import { DeployDialog } from "./DeployDialog.tsx";
import { McpInstallDialog } from "./McpInstallDialog.tsx";
import { SetupTodosView } from "./SetupTodosView.tsx";
import { useDemoExploration } from "./demoExploration.tsx";
import { BoltIcon, GithubIcon, SlackIcon, TerminalIcon } from "./icons.tsx";
import type { Todo, TodoId } from "./types.ts";

function buildTodos({
  githubConnected,
  slackConnected,
  hasEvents,
  mcpConnected,
}: {
  githubConnected: boolean;
  slackConnected: boolean;
  hasEvents: boolean;
  mcpConnected: boolean;
}): Todo[] {
  const todos: Todo[] = [];
  if (!hasEvents) {
    todos.push({
      id: "deploy",
      icon: <BoltIcon />,
      title: "Deploy your code",
      desc: "Push the code to the production / sandbox environment as you do, or run it locally. We'll tell you when we start receiving events from your code.",
      cta: "View deploy guide",
      variant: "primary",
    });
  }
  if (!githubConnected) {
    todos.push({
      id: "github",
      icon: <GithubIcon />,
      title: "Let us fix your bugs",
      desc: "Connect your GitHub so our agent can investigate bugs and submit PRs.",
      cta: "Connect GitHub",
      variant: "primary",
    });
  }
  if (!slackConnected) {
    todos.push({
      id: "slack",
      icon: <SlackIcon />,
      title: "Get PRs with fixes in your Slack",
      desc: "Connect Superlog to Slack to get helpful incident summaries and fixes in your #ops channel.",
      cta: "Connect Slack",
      variant: "primary",
    });
  }
  if (!mcpConnected) {
    todos.push({
      id: "mcp",
      icon: <TerminalIcon />,
      title: "Install the MCP server",
      desc: "Hook Superlog into your editor. Your agent can query traces, logs, and incidents directly while it codes.",
      cta: "View install instructions",
      variant: "primary",
    });
  }
  return todos;
}

function isStatsZero(stats: Stats | undefined): boolean {
  if (!stats) return true;
  return stats.traces + stats.logs + stats.metrics === 0;
}

export function setupSignalsSettled(
  signals: Array<{ data: unknown; error: unknown }>,
): boolean {
  return signals.every((signal) => signal.data !== undefined || signal.error != null);
}

export function SetupTodos({ projectId }: { projectId: string }) {
  const { exploring, stopExploring } = useDemoExploration();
  const github = useGithubInstallation();
  const slack = useSlackInstallation();
  const stats = useStats(projectId);
  const mcp = useMcpStatus(projectId);
  const startGithub = useStartGithubInstall();
  const startSlack = useStartSlackInstall();
  const showDemoExploringBanner = exploring;

  const [mcpOpen, setMcpOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);

  if (showDemoExploringBanner) {
    return <SetupTodosView showDemoExploringBanner stopExploring={stopExploring} />;
  }

  // Hold off the first paint until every signal has resolved once — otherwise
  // a fully-onboarded user briefly sees all four todos (every `…Connected`
  // flag defaults to false) before they collapse to the empty state.
  // Background refetches keep `data` populated so this only blocks the very
  // first render.
  if (!setupSignalsSettled([github, slack, stats, mcp])) {
    return null;
  }

  const githubConnected = github.data?.installed === true;
  const slackConnected = !!slack.data && slack.data.installed === true;
  const hasEvents = !isStatsZero(stats.data);
  const mcpConnected = mcp.data?.connected === true;

  const todos = buildTodos({ githubConnected, slackConnected, hasEvents, mcpConnected });

  // The stepper covers the four auto-detected setup steps. Each flips when its
  // underlying signal does — events arriving, GitHub install, Slack install,
  // first MCP OAuth token issued.
  const signals = [hasEvents, githubConnected, slackConnected, mcpConnected];
  const total = signals.length;
  const completed = signals.filter(Boolean).length;

  const handleAction = (t: Todo) => {
    if (t.id === "github") {
      startGithub.mutate(undefined, {
        onSuccess: ({ url }) => {
          window.location.assign(url);
        },
      });
    } else if (t.id === "slack") {
      startSlack.mutate(undefined, {
        onSuccess: ({ url }) => {
          window.location.assign(url);
        },
      });
    } else if (t.id === "mcp") {
      setMcpOpen(true);
    } else if (t.id === "deploy") {
      setDeployOpen(true);
    }
  };

  const busyId: TodoId | null = startGithub.isPending
    ? "github"
    : startSlack.isPending
      ? "slack"
      : null;

  return (
    <>
      <SetupTodosView
        showDemoExploringBanner={false}
        todos={todos}
        busyId={busyId}
        total={total}
        completed={completed}
        onAction={handleAction}
      />
      {mcpOpen && <McpInstallDialog onClose={() => setMcpOpen(false)} />}
      {deployOpen && <DeployDialog projectId={projectId} onClose={() => setDeployOpen(false)} />}
    </>
  );
}
