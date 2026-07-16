export const MAX_ENABLED_CUSTOM_MCP_SERVERS = 19;

const MAX_DISPLAY_NAME_LENGTH = 80;
const RESERVED_NAMES = new Set(["superlog"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_API_KEY_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
]);

export type ProjectMcpServerAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "api_key"; headerName: string; key: string; relayToken: string }
  | {
      type: "oauth";
      grantType: "authorization_code" | "client_credentials";
      status: "pending" | "connected" | "error";
      scopes: string[];
      clientId: string | null;
      clientSecret: string | null;
      accessToken: string | null;
      refreshToken: string | null;
      expiresAt: Date | null;
      tokenEndpoint: string | null;
      authorizationServer: string | null;
      resource: string | null;
    };

export type ProjectMcpServer = {
  id: string;
  projectId: string;
  /** Protocol-safe identifier used when attaching the MCP server to an agent. */
  name: string;
  displayName: string;
  url: string;
  enabled: boolean;
  auth: ProjectMcpServerAuth;
  trustedAt: Date;
  trustedByUserId: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NewProjectMcpServer = Omit<ProjectMcpServer, "id" | "createdAt" | "updatedAt">;

export type ProjectMcpServerView = Omit<
  ProjectMcpServer,
  "auth" | "name" | "displayName" | "trustedAt" | "createdAt" | "updatedAt"
> & {
  name: string;
  slug: string;
  auth:
    | { type: "none"; hasCredential: false }
    | { type: "bearer"; hasCredential: true }
    | { type: "api_key"; hasCredential: true; headerName: string }
    | {
        type: "oauth";
        grantType: "authorization_code" | "client_credentials";
        hasCredential: boolean;
        status: "pending" | "connected" | "error";
        scopes: string[];
        expiresAt: string | null;
      };
  trustedAt: string;
  createdAt: string;
  updatedAt: string;
};

export interface ProjectMcpServerRepository {
  list(projectId: string): Promise<ProjectMcpServer[]>;
  get(projectId: string, id: string): Promise<ProjectMcpServer | null>;
  insert(input: NewProjectMcpServer): Promise<ProjectMcpServer>;
  update(server: ProjectMcpServer): Promise<ProjectMcpServer>;
  delete(projectId: string, id: string): Promise<boolean>;
}

export type ProjectMcpServerErrorCode =
  | "invalid_name"
  | "reserved_name"
  | "invalid_url"
  | "trust_required"
  | "duplicate_name"
  | "duplicate_url"
  | "enabled_limit"
  | "not_found"
  | "invalid_auth";

export class ProjectMcpServerError extends Error {
  constructor(
    readonly code: ProjectMcpServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectMcpServerError";
  }
}

export function createProjectMcpServerManager(repository: ProjectMcpServerRepository) {
  return {
    async list(projectId: string): Promise<ProjectMcpServerView[]> {
      return (await repository.list(projectId)).map(toProjectMcpServerView);
    },

    async add(command: {
      projectId: string;
      actorUserId: string | null;
      name: string;
      url: string;
      enabled?: boolean;
      auth: ProjectMcpServerAuth;
      confirmTrusted: boolean;
    }): Promise<ProjectMcpServerView> {
      if (!command.confirmTrusted) {
        throw new ProjectMcpServerError("trust_required", "the MCP server must be trusted");
      }
      const displayName = parseProjectMcpServerName(command.name);
      const name = projectMcpServerSlug(displayName);
      const url = parseProjectMcpServerUrl(command.url);
      const existing = await repository.list(command.projectId);
      if (existing.some((server) => server.name === name)) {
        throw new ProjectMcpServerError(
          "duplicate_name",
          `MCP server name already exists: ${name}`,
        );
      }
      if (existing.some((server) => server.url === url)) {
        throw new ProjectMcpServerError("duplicate_url", `MCP server URL already exists: ${url}`);
      }
      const enabled = command.enabled ?? true;
      if (
        enabled &&
        existing.filter((server) => server.enabled).length >= MAX_ENABLED_CUSTOM_MCP_SERVERS
      ) {
        throw new ProjectMcpServerError(
          "enabled_limit",
          `a project may have at most ${MAX_ENABLED_CUSTOM_MCP_SERVERS} enabled custom MCP servers`,
        );
      }
      const now = new Date();
      return toProjectMcpServerView(
        await repository.insert({
          projectId: command.projectId,
          name,
          displayName,
          url,
          enabled,
          auth: validateAuth(command.auth),
          trustedAt: now,
          trustedByUserId: command.actorUserId,
          createdByUserId: command.actorUserId,
          updatedByUserId: command.actorUserId,
        }),
      );
    },

    async update(command: {
      projectId: string;
      id: string;
      actorUserId: string | null;
      name?: string;
      url?: string;
      enabled?: boolean;
      auth?: ProjectMcpServerAuth;
      confirmTrusted?: boolean;
    }): Promise<ProjectMcpServerView> {
      const current = await repository.get(command.projectId, command.id);
      if (!current) throw new ProjectMcpServerError("not_found", "MCP server not found");
      const displayName =
        command.name === undefined ? current.displayName : parseProjectMcpServerName(command.name);
      const name = command.name === undefined ? current.name : projectMcpServerSlug(displayName);
      const url = command.url === undefined ? current.url : parseProjectMcpServerUrl(command.url);
      if (url !== current.url && !command.confirmTrusted) {
        throw new ProjectMcpServerError("trust_required", "the new MCP server URL must be trusted");
      }
      const existing = await repository.list(command.projectId);
      if (existing.some((server) => server.id !== current.id && server.name === name)) {
        throw new ProjectMcpServerError(
          "duplicate_name",
          `MCP server name already exists: ${name}`,
        );
      }
      if (existing.some((server) => server.id !== current.id && server.url === url)) {
        throw new ProjectMcpServerError("duplicate_url", `MCP server URL already exists: ${url}`);
      }
      const enabled = command.enabled ?? current.enabled;
      if (
        enabled &&
        !current.enabled &&
        existing.filter((server) => server.enabled).length >= MAX_ENABLED_CUSTOM_MCP_SERVERS
      ) {
        throw new ProjectMcpServerError(
          "enabled_limit",
          `a project may have at most ${MAX_ENABLED_CUSTOM_MCP_SERVERS} enabled custom MCP servers`,
        );
      }
      const now = new Date();
      return toProjectMcpServerView(
        await repository.update({
          ...current,
          name,
          displayName,
          url,
          enabled,
          auth: command.auth === undefined ? current.auth : validateAuth(command.auth),
          trustedAt: url === current.url ? current.trustedAt : now,
          trustedByUserId: url === current.url ? current.trustedByUserId : command.actorUserId,
          updatedByUserId: command.actorUserId,
          updatedAt: now,
        }),
      );
    },

    async remove(projectId: string, id: string): Promise<void> {
      if (!(await repository.delete(projectId, id))) {
        throw new ProjectMcpServerError("not_found", "MCP server not found");
      }
    },
  };
}

export function parseProjectMcpServerName(value: string): string {
  const name = value.trim();
  if (!name || name.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ProjectMcpServerError(
      "invalid_name",
      `MCP server name must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  const slug = projectMcpServerSlug(name);
  if (RESERVED_NAMES.has(slug)) {
    throw new ProjectMcpServerError("reserved_name", `${name} is reserved`);
  }
  return name;
}

export function projectMcpServerSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64)
    .replace(/[-_]+$/g, "");
  if (!slug) {
    throw new ProjectMcpServerError(
      "invalid_name",
      "MCP server name must include at least one letter or number",
    );
  }
  return slug;
}

export function parseProjectMcpServerUrl(value: string): string {
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProjectMcpServerError("invalid_url", "URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ProjectMcpServerError(
      "invalid_url",
      "URL must use HTTPS and must not contain credentials",
    );
  }
  return parsed.toString();
}

function validateAuth(auth: ProjectMcpServerAuth): ProjectMcpServerAuth {
  if (auth.type === "bearer") {
    const token = auth.token.trim();
    if (!token) throw new ProjectMcpServerError("invalid_auth", "bearer token is required");
    return { type: "bearer", token };
  }
  if (auth.type === "api_key") {
    const headerName = auth.headerName.trim();
    const key = auth.key.trim();
    const relayToken = auth.relayToken.trim();
    if (
      !HEADER_NAME_PATTERN.test(headerName) ||
      FORBIDDEN_API_KEY_HEADERS.has(headerName.toLowerCase())
    ) {
      throw new ProjectMcpServerError("invalid_auth", "API key header is not allowed");
    }
    if (!key || !relayToken) {
      throw new ProjectMcpServerError("invalid_auth", "API key and relay token are required");
    }
    return { type: "api_key", headerName, key, relayToken };
  }
  if (auth.type === "oauth") {
    if (
      auth.grantType === "client_credentials" &&
      (!auth.clientId?.trim() || !auth.clientSecret?.trim())
    ) {
      throw new ProjectMcpServerError(
        "invalid_auth",
        "OAuth client credentials requires a client ID and client secret",
      );
    }
    return {
      ...auth,
      scopes: [...new Set(auth.scopes.map((scope) => scope.trim()).filter(Boolean))],
      clientId: auth.clientId?.trim() || null,
      clientSecret: auth.clientSecret?.trim() || null,
    };
  }
  return auth;
}

export function toProjectMcpServerView(server: ProjectMcpServer): ProjectMcpServerView {
  const auth: ProjectMcpServerView["auth"] =
    server.auth.type === "none"
      ? { type: "none", hasCredential: false }
      : server.auth.type === "bearer"
        ? { type: "bearer", hasCredential: true }
        : server.auth.type === "api_key"
          ? {
              type: "api_key",
              hasCredential: true,
              headerName: server.auth.headerName,
            }
          : {
              type: "oauth",
              grantType: server.auth.grantType,
              hasCredential: !!server.auth.accessToken,
              status: server.auth.status,
              scopes: server.auth.scopes,
              expiresAt: server.auth.expiresAt?.toISOString() ?? null,
            };
  const { displayName, ...rest } = server;
  return {
    ...rest,
    name: displayName,
    slug: server.name,
    auth,
    trustedAt: server.trustedAt.toISOString(),
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
  };
}
