import type {
  GcpConnectionRecord,
  GcpConnectionRepository,
  GcpGateway,
  GcpProvisioningInput,
  ProvisionedGcpConnection,
} from "./domain.js";

export type GcpApplicationConfig = {
  integrationProjectId: string;
  readerServiceAccountEmail: string;
  pushServiceAccountEmail: string;
  pushAudience: string;
  pushEndpoint: string;
};

export const MAX_GCP_LOG_EXCLUSIONS = 200;

export class GcpLogExclusionError extends Error {
  constructor(
    readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "GcpLogExclusionError";
  }
}

export async function updateGcpLogExclusions(input: {
  projectId: string;
  excludedLogNames: unknown;
  repository: GcpConnectionRepository;
}): Promise<GcpConnectionRecord> {
  const connection = await input.repository.findCurrent(input.projectId);
  if (!connection || connection.status !== "connected" || connection.revokedAt) {
    throw new GcpLogExclusionError("not_found", "Connected GCP project not found");
  }
  if (!Array.isArray(input.excludedLogNames)) {
    throw new GcpLogExclusionError("invalid", "excludedLogNames must be an array");
  }
  if (input.excludedLogNames.length > MAX_GCP_LOG_EXCLUSIONS) {
    throw new GcpLogExclusionError(
      "invalid",
      `At most ${MAX_GCP_LOG_EXCLUSIONS} GCP log names can be excluded`,
    );
  }

  const prefix = `projects/${connection.gcpProjectId}/logs/`;
  const excludedLogNames = Array.from(
    new Set(
      input.excludedLogNames.map((value) => {
        if (typeof value !== "string") {
          throw new GcpLogExclusionError("invalid", "Every excluded log name must be a string");
        }
        const logName = value.trim();
        if (
          !logName.startsWith(prefix) ||
          logName.length === prefix.length ||
          logName.length > 512
        ) {
          throw new GcpLogExclusionError(
            "invalid",
            "Excluded log names must belong to the connected GCP project",
          );
        }
        return logName;
      }),
    ),
  ).sort();

  return input.repository.updateExcludedLogNames(connection.id, excludedLogNames);
}

export async function completeGcpConnect(input: {
  connectionId: string;
  code?: string;
  userAccessToken?: string;
  gcpProjectNumber?: string;
  repository: GcpConnectionRepository;
  gateway: GcpGateway;
  config: GcpApplicationConfig;
}): Promise<GcpConnectionRecord> {
  const connection = await input.repository.findById(input.connectionId);
  if (!connection || connection.revokedAt) throw new Error("GCP connection not found");
  if (connection.status === "connected") return connection;
  if (connection.status === "disconnecting") {
    throw new Error("GCP disconnect is in progress");
  }
  const current = await input.repository.findCurrent(connection.projectId);
  const superseded =
    current?.status === "connected" && current.id !== connection.id ? current : null;

  await input.repository.markProvisioning(connection.id);
  let accessToken: string | null = null;
  let provisioned: Awaited<ReturnType<GcpGateway["provision"]>> | null = null;
  let supersededCleanupAttempted = false;
  try {
    if (input.userAccessToken) {
      accessToken = input.userAccessToken;
    } else if (input.code) {
      ({ accessToken } = await input.gateway.exchangeCode(input.code));
    } else {
      throw new Error("Google OAuth authorization is required");
    }
    provisioned = await input.gateway.provision(
      provisioningInput(connection, accessToken, input.config, input.gcpProjectNumber),
    );
    await input.repository.ensureIngestKey(connection.id, connection.projectId);
    if (superseded) {
      supersededCleanupAttempted = true;
      await input.gateway.deprovision({
        connectionId: superseded.id,
        gcpProjectId: superseded.gcpProjectId,
        userAccessToken: accessToken,
        integrationProjectId: input.config.integrationProjectId,
        readerServiceAccountEmail: superseded.readerServiceAccountEmail,
        provisioned: await cleanupProvisioningResult(
          superseded,
          persistedProvisioningResult(superseded),
          input.repository,
        ),
      });
    }
    return await input.repository.markConnected(connection.id, provisioned, superseded?.id ?? null);
  } catch (error) {
    let message = error instanceof Error ? error.message : "GCP provisioning failed";
    if (accessToken && superseded && supersededCleanupAttempted) {
      let restoreSuperseded = true;
      try {
        const latest = await input.repository.findById(superseded.id);
        restoreSuperseded = latest?.status === "connected" && !latest.revokedAt;
      } catch {
        // Preserve the original recovery behavior when persistence itself is unavailable.
      }
      if (restoreSuperseded) {
        try {
          await input.gateway.provision(provisioningInput(superseded, accessToken, input.config));
        } catch (restoreError) {
          const restoreMessage =
            restoreError instanceof Error ? restoreError.message : "unknown restore error";
          message = `${message}; previous connection restore failed: ${restoreMessage}`;
        }
      }
    }
    if (accessToken && provisioned) {
      try {
        await input.gateway.deprovision({
          connectionId: connection.id,
          gcpProjectId: connection.gcpProjectId,
          userAccessToken: accessToken,
          integrationProjectId: input.config.integrationProjectId,
          readerServiceAccountEmail: connection.readerServiceAccountEmail,
          provisioned: await cleanupProvisioningResult(connection, provisioned, input.repository),
        });
      } catch (cleanupError) {
        const cleanupMessage =
          cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error";
        message = `${message}; cleanup failed: ${cleanupMessage}`;
      }
    }
    await input.repository.markFailed(connection.id, message);
    throw error;
  }
}

export async function disconnectGcpConnection(input: {
  projectId: string;
  expectedConnectionId?: string;
  userAccessToken: string;
  repository: GcpConnectionRepository;
  gateway: GcpGateway;
  config: GcpApplicationConfig;
}): Promise<GcpConnectionRecord> {
  const connection = input.expectedConnectionId
    ? await input.repository.findById(input.expectedConnectionId)
    : await input.repository.findCurrent(input.projectId);
  if (!connection || connection.status !== "connected" || connection.revokedAt) {
    throw new Error("Connected GCP project not found");
  }
  if (connection.projectId !== input.projectId) {
    throw new Error("Connected GCP project not found");
  }
  if (input.expectedConnectionId && connection.id !== input.expectedConnectionId) {
    throw new Error("Connected GCP project changed during authorization");
  }
  const persistedProvisioning = persistedProvisioningResult(connection);
  await input.repository.claimDisconnect(connection.id);
  let cleanupAttempted = false;
  try {
    const provisioned = await cleanupProvisioningResult(
      connection,
      persistedProvisioning,
      input.repository,
    );
    cleanupAttempted = true;
    await input.gateway.deprovision({
      connectionId: connection.id,
      gcpProjectId: connection.gcpProjectId,
      userAccessToken: input.userAccessToken,
      integrationProjectId: input.config.integrationProjectId,
      readerServiceAccountEmail: connection.readerServiceAccountEmail,
      provisioned,
    });
    return await input.repository.revoke(connection.id);
  } catch (error) {
    let restoreConnection = true;
    try {
      const latest = await input.repository.findById(connection.id);
      restoreConnection = latest?.status === "disconnecting" && !latest.revokedAt;
    } catch {
      // If persistence is unavailable, prefer restoring the resources for the
      // connection that the database most likely still considers active.
    }
    if (restoreConnection) {
      if (cleanupAttempted) {
        try {
          await input.gateway.provision(
            provisioningInput(
              connection,
              input.userAccessToken,
              input.config,
              connection.gcpProjectNumber ?? undefined,
            ),
          );
        } catch (restoreError) {
          const originalMessage = error instanceof Error ? error.message : "GCP disconnect failed";
          const restoreMessage =
            restoreError instanceof Error ? restoreError.message : "unknown restore error";
          throw new Error(`${originalMessage}; connection restore failed: ${restoreMessage}`, {
            cause: error,
          });
        }
      }
      try {
        await input.repository.releaseDisconnect(connection.id);
      } catch (releaseError) {
        const originalMessage = error instanceof Error ? error.message : "GCP disconnect failed";
        const releaseMessage =
          releaseError instanceof Error ? releaseError.message : "unknown release error";
        throw new Error(`${originalMessage}; disconnect claim release failed: ${releaseMessage}`, {
          cause: error,
        });
      }
    }
    throw error;
  }
}

async function cleanupProvisioningResult(
  connection: GcpConnectionRecord,
  provisioned: ProvisionedGcpConnection,
  repository: GcpConnectionRepository,
): Promise<ProvisionedGcpConnection> {
  if (!provisioned.monitoringViewerGrantCreated) return provisioned;
  const removeGrant = await repository.prepareMonitoringGrantRemoval({
    connectionId: connection.id,
    gcpProjectId: connection.gcpProjectId,
    readerServiceAccountEmail: connection.readerServiceAccountEmail,
    grantCreated: provisioned.monitoringViewerGrantCreated,
  });
  return { ...provisioned, monitoringViewerGrantCreated: removeGrant };
}

function provisioningInput(
  connection: GcpConnectionRecord,
  accessToken: string,
  config: GcpApplicationConfig,
  gcpProjectNumber?: string,
): GcpProvisioningInput {
  return {
    connectionId: connection.id,
    gcpProjectId: connection.gcpProjectId,
    ...(gcpProjectNumber ? { gcpProjectNumber } : {}),
    userAccessToken: accessToken,
    integrationProjectId: config.integrationProjectId,
    readerServiceAccountEmail: connection.readerServiceAccountEmail,
    pushServiceAccountEmail: config.pushServiceAccountEmail,
    pushAudience: config.pushAudience,
    pushEndpoint: `${config.pushEndpoint.replace(/\/$/, "")}/${connection.id}`,
  };
}

function persistedProvisioningResult(connection: GcpConnectionRecord): ProvisionedGcpConnection {
  if (
    !connection.gcpProjectNumber ||
    !connection.topicName ||
    !connection.subscriptionName ||
    !connection.logSinkName ||
    !connection.logSinkWriterIdentity
  ) {
    throw new Error("Connected GCP connection is missing provisioned resource metadata");
  }
  return {
    gcpProjectNumber: connection.gcpProjectNumber,
    topicName: connection.topicName,
    subscriptionName: connection.subscriptionName,
    logSinkName: connection.logSinkName,
    logSinkWriterIdentity: connection.logSinkWriterIdentity,
    monitoringViewerGrantCreated: connection.monitoringViewerGrantCreated,
  };
}
