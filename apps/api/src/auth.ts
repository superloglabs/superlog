import { db, schema } from "@superlog/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { autumn } from "autumn-js/better-auth";
import { eq } from "drizzle-orm";
import {
  orgInvitationEmailBody,
  passwordResetEmailBody,
  sendEmail,
  verificationEmailBody,
} from "./email.js";

// Better Auth server config. Mounted at /api/auth/* by apps/api/src/index.ts.
//
// Schema mapping: we reuse our existing `users`, `orgs`, `org_members` tables
// instead of letting Better Auth own parallel ones. The drizzle adapter
// accepts a `schema` map keyed by the model names BA expects. The
// organization plugin's `member.organizationId` and `invitation.organizationId`
// columns live on the `orgId` TS property in our schema, so we map those
// explicitly via the plugin's `schema.X.fields` config.
//
// Identity is UUID end-to-end: `advanced.database.generateId` makes BA emit
// UUIDs for new rows so foreign keys to our existing uuid columns line up.

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const API_ORIGIN = process.env.BETTER_AUTH_URL ?? "http://localhost:4100";

// Derive the parent domain that web and api share so the OAuth state cookie
// is scoped to `.<eTLD+1>` instead of pinned to the api host. For prod that's
// `.superlog.sh`; for localhost / .superlog.localhost it's `undefined`
// because browsers won't honour Domain= on a TLD or localhost.
function sharedCookieDomain(): string | undefined {
  try {
    const apiHost = new URL(API_ORIGIN).hostname;
    const webHost = new URL(WEB_ORIGIN).hostname;
    if (apiHost === webHost) return undefined; // same host, no cross-sub needed
    if (apiHost === "localhost" || webHost === "localhost") return undefined;
    if (apiHost.endsWith(".localhost") || webHost.endsWith(".localhost")) return undefined;
    // Trim to the longest common dotted suffix shared by both hosts. For
    // api.superlog.sh / superlog.sh that yields "superlog.sh".
    const a = apiHost.split(".");
    const b = webHost.split(".");
    const parts: string[] = [];
    while (a.length && b.length && a[a.length - 1] === b[b.length - 1]) {
      parts.unshift(a.pop() as string);
      b.pop();
    }
    if (parts.length < 2) return undefined; // needs at least eTLD+1
    return `.${parts.join(".")}`;
  } catch {
    return undefined;
  }
}

const COOKIE_DOMAIN = sharedCookieDomain();

// Autumn billing plugin. Maps each org (a Better Auth "organization") to an
// Autumn customer, auto-created on first sign-in, so billing is per-org. Only
// enabled when AUTUMN_SECRET_KEY is present, so local dev / worktrees without
// billing config keep working — same opt-in pattern as the social providers.
const autumnPlugins = process.env.AUTUMN_SECRET_KEY
  ? [autumn({ customerScope: "organization" })]
  : [];

// Fail loud and early if the signing secret is missing. Better Auth doesn't
// throw on undefined `secret` — depending on the build it falls back to a
// fresh random value per process start, which silently invalidates every
// session on every deploy. Match the previous CLERK_SECRET_KEY guard so
// missing config surfaces as a startup error, not a slow-burn outage.
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
if (!BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is required");

// Both providers stay disabled when their client IDs are missing — Better
// Auth's `socialProviders` map only enables what's present, so dropping the
// keys here is enough to hide the buttons in dev without breaking sign-up.
const googleProvider =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }
    : undefined;

const githubProvider =
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        // GitHub returns email: null in /user when the address is set to
        // "Keep my email addresses private". user:email scope lets Better Auth
        // fall back to /user/emails for the verified primary. Has no effect on
        // GitHub Apps (which derive scopes from the App's User permissions) —
        // for those, enable the "Email addresses" user permission on the App.
        scope: ["user:email", "read:user"],
      }
    : undefined;

// Picks the org to make active for a session. Prefers an explicit override
// (set via the org plugin's setActive API) then falls back to the user's
// first membership. Returns null if the user has no memberships — that's an
// error state callers can decide how to handle.
async function pickActiveOrgId(userId: string): Promise<string | null> {
  const membership = await db.query.orgMembers.findFirst({
    where: eq(schema.orgMembers.userId, userId),
  });
  return membership?.orgId ?? null;
}

export const auth = betterAuth({
  baseURL: API_ORIGIN,
  secret: BETTER_AUTH_SECRET,
  trustedOrigins: [WEB_ORIGIN],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      organization: schema.orgs,
      member: schema.orgMembers,
      invitation: schema.invitations,
    },
  }),
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
    // Web and API often live on different subdomains of the same parent
    // domain (e.g. `superlog.sh` + `api.superlog.sh`). The OAuth state
    // cookie has to round-trip from BA's `/api/auth/sign-in/social` response
    // through the provider and back to `/api/auth/callback/<provider>`; if
    // the cookie is pinned to the API host instead of the parent domain it
    // can fail to ride along on some browsers and BA returns
    // `State mismatch: verification not found`. When the hosts share an
    // eTLD+1, scope to the parent. localhost / *.localhost are skipped
    // because browsers reject Domain= on those.
    ...(COOKIE_DOMAIN
      ? {
          crossSubDomainCookies: { enabled: true, domain: COOKIE_DOMAIN },
          defaultCookieAttributes: { sameSite: "lax" as const, secure: true },
        }
      : {}),
  },
  emailAndPassword: {
    enabled: true,
    // Sign-ups still land logged-in immediately to keep dev/worktree flows
    // fast — the verification email is still sent (see `emailVerification`
    // below) so the user can confirm at their leisure. Flip this to true once
    // we want to gate /api/* access on a verified address.
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => {
      const body = passwordResetEmailBody(url);
      await sendEmail({ to: user.email, subject: "Reset your Superlog password", ...body });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const body = verificationEmailBody(url);
      await sendEmail({ to: user.email, subject: "Confirm your email for Superlog", ...body });
    },
  },
  socialProviders: {
    ...(googleProvider ? { google: googleProvider } : {}),
    ...(githubProvider ? { github: githubProvider } : {}),
  },
  plugins: [
    organization({
      schema: {
        // Our `org_members` table uses `orgId` (TS) / `org_id` (SQL) instead
        // of Better Auth's expected `organizationId`. Same for `invitations`.
        member: {
          fields: { organizationId: "orgId" },
        },
        invitation: {
          fields: { organizationId: "orgId" },
        },
      },
      sendInvitationEmail: async ({ id, email, role, organization, inviter }) => {
        const url = `${WEB_ORIGIN}/accept-invitation?id=${encodeURIComponent(id)}`;
        const body = orgInvitationEmailBody({
          url,
          orgName: organization.name,
          inviterEmail: inviter.user.email,
          inviterName: inviter.user.name,
          role,
        });
        await sendEmail({
          to: email,
          subject: `You're invited to ${organization.name} on Superlog`,
          ...body,
        });
      },
    }),
    admin(),
    ...autumnPlugins,
  ],
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          // Seed the active org so the first request after sign-in already
          // has org context. If the user has no memberships yet (e.g. on a
          // bootstrap race) leave it null; callers handle that.
          if (session.activeOrganizationId) return { data: session };
          const activeOrganizationId = await pickActiveOrgId(session.userId);
          return { data: { ...session, activeOrganizationId } };
        },
      },
    },
  },
});

export type Auth = typeof auth;
