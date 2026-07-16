export type ProjectMcpAuthDetection =
  | {
      type: "oauth";
      grantType: "authorization_code" | "client_credentials";
      supportsDynamicRegistration: boolean;
    }
  | { type: "unknown" };

export type ProjectMcpOAuthDiscoverer = {
  discover(serverUrl: string): Promise<{
    grantTypes: string[];
    registrationEndpoint: string | null;
  }>;
};

export async function detectProjectMcpAuth(
  serverUrl: string,
  oauth: ProjectMcpOAuthDiscoverer,
): Promise<ProjectMcpAuthDetection> {
  try {
    const discovery = await oauth.discover(serverUrl);
    const grantType =
      discovery.grantTypes.includes("client_credentials") &&
      !discovery.grantTypes.includes("authorization_code")
        ? "client_credentials"
        : "authorization_code";
    return {
      type: "oauth",
      grantType,
      supportsDynamicRegistration: discovery.registrationEndpoint !== null,
    };
  } catch {
    return { type: "unknown" };
  }
}
