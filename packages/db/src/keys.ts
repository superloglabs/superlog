import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "sl_public_";
export const LEGACY_API_KEY_PREFIX = "superlog_live_";
export const ORG_MANAGEMENT_KEY_PREFIX = "sl_management_";
const CLI_SESSION_PREFIX = "superlog_cli_";
const MCP_ACCESS_PREFIX = "superlog_mcp_at_";
const MCP_REFRESH_PREFIX = "superlog_mcp_rt_";
export const PERSONAL_ACCESS_TOKEN_PREFIX = "superlog_pat_";
const SECRET_BYTES = 32;

export type GeneratedKey = {
  plaintext: string;
  hash: string;
  prefix: string;
};

export function generateApiKey(): GeneratedKey {
  return generateToken(API_KEY_PREFIX);
}

export function generateCliSession(): GeneratedKey {
  return generateToken(CLI_SESSION_PREFIX);
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function hashCliSession(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function isCliSessionToken(plaintext: string): boolean {
  return plaintext.startsWith(CLI_SESSION_PREFIX);
}

export function isIngestApiKey(plaintext: string): boolean {
  return plaintext.startsWith(API_KEY_PREFIX) || plaintext.startsWith(LEGACY_API_KEY_PREFIX);
}

export function generateOrgManagementKey(): GeneratedKey {
  return generateToken(ORG_MANAGEMENT_KEY_PREFIX);
}

export function isOrgManagementKey(plaintext: string): boolean {
  return plaintext.startsWith(ORG_MANAGEMENT_KEY_PREFIX);
}

export function generateMcpAccessToken(): GeneratedKey {
  return generateToken(MCP_ACCESS_PREFIX);
}

export function generateMcpRefreshToken(): GeneratedKey {
  return generateToken(MCP_REFRESH_PREFIX);
}

export function generatePersonalAccessToken(): GeneratedKey {
  return generateToken(PERSONAL_ACCESS_TOKEN_PREFIX);
}

export function isPersonalAccessToken(plaintext: string): boolean {
  return plaintext.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX);
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generateToken(prefix: string): GeneratedKey {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `${prefix}${secret}`;
  return {
    plaintext,
    hash: createHash("sha256").update(plaintext).digest("hex"),
    prefix: plaintext.slice(0, prefix.length + 6),
  };
}
