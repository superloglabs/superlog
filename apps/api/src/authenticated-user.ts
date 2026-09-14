import { auth } from "./auth.js";

export async function getAuthenticatedUserId(headers: Headers): Promise<string | null> {
  const session = await auth.api.getSession({ headers });
  return session?.user.id ?? null;
}
