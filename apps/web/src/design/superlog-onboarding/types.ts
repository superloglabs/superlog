export type ProgressStyle = "rail" | "top" | "dots";
export type AgentChoice = "self" | "wizard";

export type SlackPref = {
  enabled: boolean;
  channel?: string;
};

export type GithubData = {
  sub?: "connect" | "repos";
  org?: string;
  repos?: string[];
  skipped?: boolean;
};

export type SlackData = {
  sub?: "connect" | "prefs";
  incidents?: SlackPref;
  recap?: SlackPref;
  skipped?: boolean;
};

export type OnboardingResult = {
  agent: AgentChoice;
  deploy: { shipped: boolean };
  github: { connected: boolean; repos: string[]; org?: string };
  slack: {
    connected: boolean;
    incidents?: SlackPref;
    recap?: SlackPref;
  };
  mcp: boolean;
  installSkipped: boolean;
  deploySkipped: boolean;
  githubSkipped: boolean;
  slackSkipped: boolean;
};
