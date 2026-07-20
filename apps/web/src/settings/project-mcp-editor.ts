import type { ProjectMcpAuthDetection, ProjectMcpServer } from "../api.ts";

export type AuthDraft = {
  type: "none" | "bearer" | "api_key" | "oauth";
  token: string;
  headerName: string;
  key: string;
  grantType: "authorization_code" | "client_credentials";
  // Explicit scope selection. An empty string means "request everything the
  // server advertises" — the server, not us, decides that set (see
  // advertisedScopes), so a read-only resource URL is honoured without the
  // operator having to type anything.
  scopes: string;
  // Scopes the server advertised at detection time; drives the customize UI.
  advertisedScopes: string[];
  clientId: string;
  clientSecret: string;
  requiresClientId: boolean;
};

export const EMPTY_AUTH: AuthDraft = {
  type: "none",
  token: "",
  headerName: "X-API-Key",
  key: "",
  grantType: "authorization_code",
  scopes: "",
  advertisedScopes: [],
  clientId: "",
  clientSecret: "",
  requiresClientId: false,
};

// Which advertised scopes are effectively requested: the operator's explicit
// selection, or — when they haven't pinned one — the full advertised set.
export function resolveSelectedScopes(scopes: string, advertised: string[]): string[] {
  const explicit = scopes.split(/\s+/).filter(Boolean);
  return explicit.length > 0 ? explicit : advertised;
}

// Toggle one advertised scope in/out of the selection, keeping advertised
// order. Re-selecting the whole set normalizes back to "" (request all), so the
// default stays future-proof if the server later widens what it offers.
export function toggleScopeSelection(scopes: string, advertised: string[], scope: string): string {
  const selected = new Set(resolveSelectedScopes(scopes, advertised));
  if (selected.has(scope)) {
    if (selected.size === 1) return scopes;
    selected.delete(scope);
  } else selected.add(scope);
  const next = advertised.filter((candidate) => selected.has(candidate));
  return next.length === advertised.length ? "" : next.join(" ");
}

export type ProjectMcpAuthSelection = "automatic" | "manual" | "required";

export function projectMcpAuthSelectionAfterUrlChange(
  selection: ProjectMcpAuthSelection,
): ProjectMcpAuthSelection {
  return selection === "required" ? "automatic" : selection;
}

export function shouldDetectProjectMcpAuth(
  selection: ProjectMcpAuthSelection,
  url: string,
  trusted: boolean,
): boolean {
  return selection === "automatic" && trusted && url.trim().length > 0;
}

export function projectMcpAuthDetectionIsCurrent(
  requestedUrl: string,
  currentUrl: string,
): boolean {
  return requestedUrl === currentUrl;
}

export async function detectProjectMcpAuthSafely<T>(detect: () => Promise<T>): Promise<T | null> {
  try {
    return await detect();
  } catch {
    return null;
  }
}

export function createDetectedProjectMcpAuthDraft(detection: ProjectMcpAuthDetection): AuthDraft {
  if (detection.type === "unknown") return EMPTY_AUTH;
  return {
    ...EMPTY_AUTH,
    type: "oauth",
    grantType: detection.grantType,
    advertisedScopes: detection.scopesSupported,
    requiresClientId:
      detection.grantType === "client_credentials" || !detection.supportsDynamicRegistration,
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
