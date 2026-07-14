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
};

export type GcpProvisioningInput = {
  connectionId: string;
  gcpProjectId: string;
  userAccessToken: string;
  integrationProjectId: string;
  readerServiceAccountEmail: string;
  pushServiceAccountEmail: string;
  pushAudience: string;
  pushEndpoint: string;
};

export interface GcpGateway {
  authorizationUrl(input: { state: string }): string;
  exchangeCode(code: string): Promise<{ accessToken: string }>;
  provision(input: GcpProvisioningInput): Promise<ProvisionedGcpConnection>;
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
  markProvisioning(id: string): Promise<void>;
  ensureIngestKey(id: string, projectId: string): Promise<void>;
  markConnected(id: string, result: ProvisionedGcpConnection): Promise<GcpConnectionRecord>;
  markFailed(id: string, error: string): Promise<void>;
}

export function parseGcpProjectId(value: unknown): string {
  if (typeof value !== "string") throw new Error("gcpProjectId is required");
  const projectId = value.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error("gcpProjectId must be a valid Google Cloud project ID");
  }
  return projectId;
}
