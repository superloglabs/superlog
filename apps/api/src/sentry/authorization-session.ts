import type { SentryInstallationToken } from "./authorization.js";
import type { SentryProject } from "./client.js";

export type SentryAuthorizationView = {
  id: string;
  organizationSlug: string;
  projects: SentryProject[];
  expiresAt: Date;
};

export type SentryAuthorizationClaim = {
  organizationSlug: string;
  sentryInstallationId: string;
  project: SentryProject;
  token: SentryInstallationToken;
};

export class SentryAuthorizationError extends Error {
  constructor(
    readonly code: "not_found" | "expired" | "consumed" | "invalid_selection" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export type SentryAuthorizationRepository = {
  expireReady(now: Date): Promise<number>;
  create(input: {
    projectId: string;
    userId: string;
    organizationSlug: string;
    sentryInstallationId: string;
    projects: SentryProject[];
    token: SentryInstallationToken;
    expiresAt: Date;
  }): Promise<SentryAuthorizationView>;
  findReady(input: {
    id: string;
    projectId: string;
    userId: string;
    now: Date;
  }): Promise<SentryAuthorizationView | null>;
  claim(input: {
    id: string;
    projectId: string;
    userId: string;
    sentryProjectSlug: string;
    now: Date;
  }): Promise<SentryAuthorizationClaim>;
};
