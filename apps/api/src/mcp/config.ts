export type McpConfig = {
  apiBaseUrl: string;
  webOrigin: string;
  resource: string;
};

export function loadMcpConfig(): McpConfig {
  const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:4100").replace(/\/$/, "");
  const webOrigin = (process.env.WEB_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
  return {
    apiBaseUrl,
    webOrigin,
    resource: `${apiBaseUrl}/mcp`,
  };
}
