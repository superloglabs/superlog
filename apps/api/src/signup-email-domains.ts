type SignupEmailDomainEnv = {
  SIGNUP_BLOCKED_EMAIL_DOMAINS?: string;
};

// Comma-separated list of email domains that may not create accounts (e.g.
// a domain sending spam sign-ups). Subdomains of a listed domain are blocked
// too. Unset = nothing blocked.
export function blockedSignupEmailDomains(env: SignupEmailDomainEnv = process.env): string[] {
  return (env.SIGNUP_BLOCKED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/^@/, "").toLowerCase())
    .filter((value) => value.length > 0);
}

export function isSignupEmailBlocked(email: string, blockedDomains: readonly string[]): boolean {
  if (blockedDomains.length === 0) return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at === -1) return false;
  const domain = normalized.slice(at + 1);
  return blockedDomains.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}
