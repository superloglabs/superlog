export function suggestOrgNameFromGoogleIdToken(idToken: string): string | null {
  const encodedPayload = idToken.split(".")[1];
  if (!encodedPayload) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      hd?: unknown;
    };
    if (typeof payload.hd !== "string") return null;

    const domainLabel = payload.hd.trim().split(".")[0];
    if (!domainLabel) return null;

    return domainLabel.charAt(0).toUpperCase() + domainLabel.slice(1);
  } catch {
    return null;
  }
}
