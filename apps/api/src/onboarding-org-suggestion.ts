const CONSUMER_EMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function suggestOrgNameFromEmail(email: string): string | null {
  const [, domain, ...extra] = email.trim().toLowerCase().split("@");
  if (!domain || extra.length > 0 || CONSUMER_EMAIL_DOMAINS.has(domain)) return null;

  const domainLabel = domain.split(".")[0];
  if (!domainLabel) return null;
  return domainLabel.charAt(0).toUpperCase() + domainLabel.slice(1);
}
