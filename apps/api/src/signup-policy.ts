// New accounts are opt-in per deployment. Production keeps sign-ups closed
// unless SIGNUPS_ENABLED=true; other environments stay open unless
// SIGNUPS_ENABLED=false.
export function newSignupsOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.SIGNUPS_ENABLED?.trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return env.NODE_ENV !== "production";
}

export const SIGNUPS_CLOSED_MESSAGE = "New sign-ups are closed.";
