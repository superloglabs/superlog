export type GcpConnectionStatus = "pending" | "provisioning" | "connected" | "failed";

export type GcpConnectionRecord = {
  id: string;
  projectId: string;
  gcpProjectId: string;
  gcpProjectNumber: string | null;
  status: GcpConnectionStatus;
  topicName: string | null;
  subscriptionName: string | null;
  logSinkName: string | null;
  logSinkWriterIdentity: string | null;
  monitoringViewerGrantCreated: boolean;
  readerServiceAccountEmail: string;
  lastVerifiedAt: Date | null;
  lastLogReceivedAt: Date | null;
  lastMetricsReceivedAt: Date | null;
  metricsBudgetMonth: string | null;
  metricsSeriesRead: number;
  lastError: string | null;
  createdBy: string;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProvisionedGcpConnection = {
  gcpProjectNumber: string;
  topicName: string;
  subscriptionName: string;
  logSinkName: string;
  logSinkWriterIdentity: string;
  monitoringViewerGrantCreated: boolean;
};

export type GcpProjectOption = {
  projectId: string;
  projectNumber: string;
  displayName: string;
};

export type GcpAuthorizationStatus = "pending" | "ready" | "consumed" | "failed";

export type GcpAuthorizationSessionRecord = {
  id: string;
  projectId: string;
  userId: string;
  status: GcpAuthorizationStatus;
  projects: GcpProjectOption[];
  expiresAt: Date;
  consumedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GcpAuthorizationClaim = {
  session: GcpAuthorizationSessionRecord;
  project: GcpProjectOption;
  accessToken: string;
};

export type GcpAuthorizationErrorCode =
  | "not_found"
  | "expired"
  | "consumed"
  | "invalid_selection"
  | "unavailable";

export class GcpAuthorizationError extends Error {
  constructor(
    readonly code: GcpAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type GcpProvisioningInput = {
  connectionId: string;
  gcpProjectId: string;
  gcpProjectNumber?: string;
  userAccessToken: string;
  integrationProjectId: string;
  readerServiceAccountEmail: string;
  pushServiceAccountEmail: string;
  pushAudience: string;
  pushEndpoint: string;
};

export type GcpDeprovisioningInput = {
  connectionId: string;
  gcpProjectId: string;
  userAccessToken: string;
  integrationProjectId: string;
  readerServiceAccountEmail: string;
  provisioned: ProvisionedGcpConnection;
};

export interface GcpGateway {
  authorizationUrl(input: { state: string }): string;
  exchangeCode(code: string): Promise<{ accessToken: string }>;
  listProjects(userAccessToken: string): Promise<GcpProjectOption[]>;
  provision(input: GcpProvisioningInput): Promise<ProvisionedGcpConnection>;
  deprovision(input: GcpDeprovisioningInput): Promise<void>;
}

export interface GcpConnectionRepository {
  create(input: {
    projectId: string;
    gcpProjectId: string;
    readerServiceAccountEmail: string;
    createdBy: string;
  }): Promise<GcpConnectionRecord>;
  findById(id: string): Promise<GcpConnectionRecord | null>;
  findCurrent(projectId: string): Promise<GcpConnectionRecord | null>;
  prepareMonitoringGrantRemoval(input: {
    connectionId: string;
    gcpProjectId: string;
    readerServiceAccountEmail: string;
    grantCreated: boolean;
  }): Promise<boolean>;
  markProvisioning(id: string): Promise<void>;
  ensureIngestKey(id: string, projectId: string): Promise<void>;
  markConnected(
    id: string,
    result: ProvisionedGcpConnection,
    supersededConnectionId: string | null,
  ): Promise<GcpConnectionRecord>;
  markFailed(id: string, error: string): Promise<void>;
}

export interface GcpAuthorizationRepository {
  create(input: {
    projectId: string;
    userId: string;
    expiresAt: Date;
  }): Promise<GcpAuthorizationSessionRecord>;
  findById(id: string): Promise<GcpAuthorizationSessionRecord | null>;
  markReady(input: {
    id: string;
    accessToken: string;
    projects: GcpProjectOption[];
    expiresAt: Date;
  }): Promise<GcpAuthorizationSessionRecord>;
  markFailed(id: string, error: string): Promise<void>;
  expire(id: string, now: Date): Promise<void>;
  claim(input: {
    id: string;
    projectId: string;
    userId: string;
    gcpProjectId: string;
    now: Date;
  }): Promise<GcpAuthorizationClaim>;
}

export function parseGcpProjectId(value: unknown): string {
  if (typeof value !== "string") throw new Error("gcpProjectId is required");
  const projectId = value.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error("gcpProjectId must be a valid Google Cloud project ID");
  }
  return projectId;
}
