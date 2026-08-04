import type { SentryProject } from "./client.js";

export type SentryProjectSelection =
  | { kind: "automatic"; project: SentryProject }
  | { kind: "choose"; projects: SentryProject[] };

export class SentryNoProjectsError extends Error {
  constructor() {
    super("Sentry organization has no accessible projects");
    this.name = "SentryNoProjectsError";
  }
}

export function planSentryProjectSelection(projects: SentryProject[]): SentryProjectSelection {
  const onlyProject = projects[0];
  if (!onlyProject) throw new SentryNoProjectsError();
  return projects.length === 1
    ? { kind: "automatic", project: onlyProject }
    : { kind: "choose", projects };
}
