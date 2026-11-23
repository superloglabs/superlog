// How the consent screen describes a dynamically registered MCP OAuth client.
// Registration is open, so a client's name is self-declared. What the user can
// rely on is where the authorization code is sent: a loopback address on their
// own computer, a native app's private-use scheme, or a web host.

// https callback hosts used by known MCP clients (exact host match).
const KNOWN_WEB_REDIRECT_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "vscode.dev",
  "insiders.vscode.dev",
]);

// Private-use URI schemes registered by known native MCP clients.
const KNOWN_APP_SCHEMES = new Set(["cursor", "vscode", "vscode-insiders", "windsurf", "claude"]);

// Product names that only the real clients should present on the consent screen.
const KNOWN_CLIENT_NAME_TOKENS = [
  "claude",
  "anthropic",
  "cursor",
  "codex",
  "openai",
  "chatgpt",
  "vscode",
  "visualstudio",
  "copilot",
  "github",
  "windsurf",
  "gemini",
  "superlog",
];

export type RedirectKind = "loopback" | "app" | "web";

export type RedirectDescription = {
  kind: RedirectKind;
  // Host for loopback and web redirects, scheme for app redirects.
  target: string;
  // True for loopback, known app schemes and known web hosts.
  trusted: boolean;
};

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function describeRedirectUri(uri: string): RedirectDescription | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol === "http:" || u.protocol === "https:") {
    if (isLoopbackHostname(u.hostname)) {
      return { kind: "loopback", target: u.hostname, trusted: true };
    }
    return {
      kind: "web",
      target: u.host,
      trusted: u.protocol === "https:" && KNOWN_WEB_REDIRECT_HOSTS.has(u.hostname),
    };
  }
  const scheme = u.protocol.slice(0, -1);
  return { kind: "app", target: scheme, trusted: KNOWN_APP_SCHEMES.has(scheme) };
}

// Any letter outside ASCII counts as a claim, since lookalike letters from
// other scripts can spell a known name without matching it.
export function claimsKnownClientName(name: string): boolean {
  const folded = name.normalize("NFKC").toLowerCase();
  if ([...folded].some((ch) => ch.charCodeAt(0) > 0x7f)) return true;
  const normalized = folded.replace(/[^a-z0-9]/g, "");
  return KNOWN_CLIENT_NAME_TOKENS.some((token) => normalized.includes(token));
}

export type ConsentClientDescription = {
  name: string;
  verified: boolean;
  redirect: RedirectDescription | null;
};

// A client counts as verified only when every redirect it registered is
// trusted, so the name shown cannot be borrowed by a registration that also
// lists an unknown web host. A known product name on an unverified client is
// prefixed so the claim is not shown as-is.
export function describeClientForConsent(
  client: { name: string; redirectUris: string[] },
  redirectUri: string | null,
): ConsentClientDescription {
  const verified =
    client.redirectUris.length > 0 &&
    client.redirectUris.every((uri) => describeRedirectUri(uri)?.trusted === true);
  const name =
    !verified && claimsKnownClientName(client.name) ? `Unverified: ${client.name}` : client.name;
  return {
    name,
    verified,
    redirect: redirectUri ? describeRedirectUri(redirectUri) : null,
  };
}

// RFC 9700 §4.11.2: with open registration, an error redirect to an unknown
// web host is an open redirect. Deny only sends the user back to trusted
// redirects; otherwise the consent page tells them to close the window.
export function shouldRedirectOnDeny(redirectUri: string): boolean {
  return describeRedirectUri(redirectUri)?.trusted === true;
}
