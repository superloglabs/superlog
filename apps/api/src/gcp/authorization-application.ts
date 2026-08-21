import {
  type GcpApplicationConfig,
  completeGcpConnect,
  disconnectGcpConnection,
} from "./application.js";
import type {
  GcpAuthorizationRepository,
  GcpAuthorizationSessionRecord,
  GcpConnectionRecord,
  GcpConnectionRepository,
  GcpGateway,
} from "./domain.js";
import { GCP_AUTHORIZATION_TTL_MS, GcpAuthorizationError, parseGcpProjectId } from "./domain.js";

export async function startGcpAuthorization(input: {
  projectId: string;
  userId: string;
  repository: GcpAuthorizationRepository;
  gateway: GcpGateway;
  signState: (authorizationId: string) => string;
  now?: Date;
}): Promise<{ session: GcpAuthorizationSessionRecord; url: string }> {
  const now = input.now ?? new Date();
  const session = await input.repository.create({
    projectId: input.projectId,
    userId: input.userId,
    expiresAt: new Date(now.getTime() + GCP_AUTHORIZATION_TTL_MS),
  });
  return {
    session,
    url: input.gateway.authorizationUrl({ state: input.signState(session.id) }),
  };
}

export async function completeGcpAuthorization(input: {
  authorizationId: string;
  code: string;
  repository: GcpAuthorizationRepository;
  gateway: GcpGateway;
  now?: Date;
}): Promise<GcpAuthorizationSessionRecord> {
  const now = input.now ?? new Date();
  const session = await input.repository.findById(input.authorizationId);
  if (!session) throw new GcpAuthorizationError("not_found", "GCP authorization not found");
  if (session.status === "ready" && session.expiresAt.getTime() > now.getTime()) return session;
  if (session.status !== "pending") {
    throw new GcpAuthorizationError("unavailable", "GCP authorization is unavailable");
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    await input.repository.markFailed(session.id, "Google OAuth authorization expired");
    throw new GcpAuthorizationError("expired", "GCP authorization expired");
  }
  try {
    const { accessToken } = await input.gateway.exchangeCode(input.code);
    const projects = (await input.gateway.listProjects(accessToken)).sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.projectId.localeCompare(right.projectId),
    );
    return await input.repository.markReady({
      id: session.id,
      accessToken,
      projects,
      expiresAt: new Date(now.getTime() + GCP_AUTHORIZATION_TTL_MS),
    });
  } catch (error) {
    await input.repository.markFailed(
      session.id,
      error instanceof Error ? error.message : "Google Cloud project discovery failed",
    );
    throw error;
  }
}

export async function getGcpAuthorizationSelection(input: {
  authorizationId: string;
  userId: string;
  repository: GcpAuthorizationRepository;
  now?: Date;
}): Promise<GcpAuthorizationSessionRecord> {
  const now = input.now ?? new Date();
  const session = await input.repository.findById(input.authorizationId);
  if (!session || session.userId !== input.userId) {
    throw new GcpAuthorizationError("not_found", "GCP authorization not found");
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    await input.repository.expire(session.id, now);
    throw new GcpAuthorizationError("expired", "GCP authorization expired");
  }
  if (session.status === "consumed") {
    throw new GcpAuthorizationError("consumed", "GCP authorization was already used");
  }
  if (session.status !== "ready") {
    throw new GcpAuthorizationError("unavailable", "GCP authorization is unavailable");
  }
  return session;
}

export async function connectGcpAuthorization(input: {
  authorizationId: string;
  userId: string;
  gcpProjectId: unknown;
  authorizationRepository: GcpAuthorizationRepository;
  connectionRepository: GcpConnectionRepository;
  gateway: GcpGateway;
  config: GcpApplicationConfig;
  now?: Date;
}): Promise<GcpConnectionRecord> {
  const now = input.now ?? new Date();
  const session = await getGcpAuthorizationSelection({
    authorizationId: input.authorizationId,
    userId: input.userId,
    repository: input.authorizationRepository,
    now,
  });
  const gcpProjectId = parseGcpProjectId(input.gcpProjectId);
  const claim = await input.authorizationRepository.claim({
    id: session.id,
    projectId: session.projectId,
    userId: session.userId,
    gcpProjectId,
    now,
  });
  const connection = await input.connectionRepository.create({
    projectId: session.projectId,
    gcpProjectId: claim.project.projectId,
    readerServiceAccountEmail: input.config.readerServiceAccountEmail,
    createdBy: session.userId,
  });
  return completeGcpConnect({
    connectionId: connection.id,
    userAccessToken: claim.accessToken,
    gcpProjectNumber: claim.project.projectNumber,
    repository: input.connectionRepository,
    gateway: input.gateway,
    config: input.config,
  });
}

export async function disconnectGcpAuthorization(input: {
  authorizationId: string;
  userId: string;
  expectedConnectionId: string;
  retryExpiresAt?: Date;
  authorizationRepository: GcpAuthorizationRepository;
  connectionRepository: GcpConnectionRepository;
  gateway: GcpGateway;
  config: GcpApplicationConfig;
  now?: Date;
}): Promise<GcpConnectionRecord> {
  const now = input.now ?? new Date();
  const session = await getGcpAuthorizationSelection({
    authorizationId: input.authorizationId,
    userId: input.userId,
    repository: input.authorizationRepository,
    now,
  });
  const connection = await input.connectionRepository.findById(input.expectedConnectionId);
  if (
    !connection ||
    connection.projectId !== session.projectId ||
    (connection.status !== "connected" && connection.status !== "failed") ||
    connection.revokedAt
  ) {
    throw new Error("Connected GCP project not found");
  }
  const claim = await input.authorizationRepository.claim({
    id: session.id,
    projectId: session.projectId,
    userId: session.userId,
    gcpProjectId: connection.gcpProjectId,
    now,
  });
  try {
    return await disconnectGcpConnection({
      projectId: session.projectId,
      expectedConnectionId: connection.id,
      userAccessToken: claim.accessToken,
      repository: input.connectionRepository,
      gateway: input.gateway,
      config: input.config,
    });
  } catch (error) {
    let latest: GcpConnectionRecord | null;
    try {
      latest = await input.connectionRepository.findById(connection.id);
    } catch {
      throw error;
    }
    if (latest?.revokedAt) return latest;
    if (!latest || (latest.status !== "connected" && latest.status !== "failed")) {
      throw error;
    }
    try {
      await input.authorizationRepository.restoreClaim({
        id: session.id,
        accessToken: claim.accessToken,
        expiresAt: new Date(
          Math.min(
            session.expiresAt.getTime(),
            input.retryExpiresAt?.getTime() ?? session.expiresAt.getTime(),
          ),
        ),
      });
    } catch (restoreError) {
      const message =
        restoreError instanceof Error ? restoreError.message : "unknown authorization error";
      throw new Error(`GCP disconnect failed; authorization recovery failed: ${message}`, {
        cause: error,
      });
    }
    throw error;
  }
}
