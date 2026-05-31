import { createAuthClient } from "better-auth/react";
import { adminClient, organizationClient } from "better-auth/client/plugins";

// Web-side Better Auth client. Talks to apps/api at /api/auth/* using cookie
// sessions. The base URL is the API origin so the cookie is set on the API
// domain — the web origin reads session state via this client, which fetches
// /api/auth/get-session under the hood with credentials: "include".

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100";

export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/auth`,
  plugins: [organizationClient(), adminClient()],
});

export const {
  useSession,
  signIn,
  signUp,
  signOut,
  organization,
  useListOrganizations,
  useActiveOrganization,
} = authClient;
