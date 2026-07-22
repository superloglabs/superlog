import type { SentryProject } from "./client.js";

export type SentryProjectSelection =
  | { kind: "automatic"; project: SentryProject }
  | { kind: "choose"; projects: SentryProject[] };

export function planSentryProjectSelection(projects: SentryProject[]): SentryProjectSelection {
  const onlyProject = projects[0];
  if (!onlyProject) throw new Error("Sentry organization has no accessible projects");
  return projects.length === 1
    ? { kind: "automatic", project: onlyProject }
    : { kind: "choose", projects };
}
