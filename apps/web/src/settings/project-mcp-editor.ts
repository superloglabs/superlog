import type { ProjectMcpAuthDetection, ProjectMcpServer } from "../api.ts";

export type AuthDraft = {
  type: "none" | "bearer" | "api_key" | "oauth";
  token: string;
  headerName: string;
  key: string;
  grantType: "authorization_code" | "client_credentials";
  scopes: string;
  clientId: string;
  clientSecret: string;
};

export const EMPTY_AUTH: AuthDraft = {
  type: "none",
  token: "",
  headerName: "X-API-Key",
  key: "",
  grantType: "authorization_code",
  scopes: "",
  clientId: "",
  clientSecret: "",
};

export function createDetectedProjectMcpAuthDraft(detection: ProjectMcpAuthDetection): AuthDraft {
  if (detection.type === "unknown") return EMPTY_AUTH;
  return {
    ...EMPTY_AUTH,
    type: "oauth",
    grantType: detection.grantType,
  };
}

export function createProjectMcpEditorDraft(server: ProjectMcpServer) {
  return {
    name: server.name,
    url: server.url,
    trusted: false,
    replaceAuth: false,
    auth: {
      ...EMPTY_AUTH,
      type: server.auth.type,
      headerName: server.auth.type === "api_key" ? server.auth.headerName : "X-API-Key",
      grantType: server.auth.type === "oauth" ? server.auth.grantType : "authorization_code",
      scopes: server.auth.type === "oauth" ? server.auth.scopes.join(" ") : "",
    } satisfies AuthDraft,
  };
}
