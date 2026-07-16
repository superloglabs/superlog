export type ProjectMcpAuthDetection =
  | {
      type: "oauth";
      grantType: "authorization_code" | "client_credentials";
      supportsDynamicRegistration: boolean;
    }
  | { type: "unknown" };

export type ProjectMcpOAuthDiscoverer = {
  discover(serverUrl: string): Promise<{
    codeChallengeMethods: string[];
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
    const supportsAuthorizationCode = discovery.grantTypes.includes("authorization_code");
    const supportsClientCredentials = discovery.grantTypes.includes("client_credentials");
    if (
      discovery.grantTypes.length > 0 &&
      !supportsAuthorizationCode &&
      !supportsClientCredentials
    ) {
      return { type: "unknown" };
    }
    const grantType =
      supportsClientCredentials && !supportsAuthorizationCode
        ? "client_credentials"
        : "authorization_code";
    if (
      grantType === "authorization_code" &&
      !discovery.codeChallengeMethods.includes("S256")
    ) {
      return { type: "unknown" };
    }
    return {
      type: "oauth",
      grantType,
      supportsDynamicRegistration: discovery.registrationEndpoint !== null,
    };
  } catch {
    return { type: "unknown" };
  }
}
