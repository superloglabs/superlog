import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PENDING_INVITE_STORAGE_KEY } from "./AcceptInvitation.tsx";
import { authClient, useSession } from "./auth-client.ts";

// /verify-email — email-address confirmation surface (B-01 fix companion).
//
// Better Auth sends the verification link on sign-up; the link hits the API's
// /api/auth/verify-email, which validates the token server-side and redirects
// here with ?verified=true (see sendVerificationEmail in apps/api/src/auth.ts).
// This page also covers the pre-verification state ("check your inbox") and
// lets signed-out users request a fresh link with just their email, so a
// signed-out unverified user is never stuck: resend needs no session.

export function VerifyEmail() {
  const [params] = useSearchParams();
  const { data: session } = useSession();
  const verified = params.get("verified") === "true";
  const paramError = params.get("error");
  const [email, setEmail] = useState(session?.user.email ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(paramError);
  // Invite continuation stashed by the accept-invitation page before the
  // signup → verify detour (see PENDING_INVITE_STORAGE_KEY).
  const [pendingInviteId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  function clearPendingInvite() {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const address = email.trim();
    if (!/.+@.+\..+/.test(address)) {
      setError("Enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await authClient.sendVerificationEmail({
        email: address,
        callbackURL: `${window.location.origin}/verify-email?verified=true`,
      });
      if (result.error) {
        setError(result.error.message ?? "Couldn't send verification email.");
        return;
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Shell>
      <h1 className="mt-5 text-center text-[22px] font-semibold tracking-[-0.015em] text-fg">
        {verified ? "Email verified" : sent ? "Check your email" : "Verify your email"}
      </h1>
      <p className="mt-2 text-center text-[14px] leading-relaxed text-muted">
        {verified
          ? "Your address is confirmed — you can now use Superlog."
          : sent
            ? `If an account exists for ${email.trim()}, we've sent a verification link. It expires in 1 hour.`
            : "We sent a verification link to your inbox at sign-up. Confirm it to unlock the dashboard, invites, and API access."}
      </p>

      {verified ? (
        <div className="mt-7 flex flex-col items-center gap-3">
          {pendingInviteId ? (
            <Link
              to={`/accept-invitation?id=${encodeURIComponent(pendingInviteId)}&join=1`}
              onClick={clearPendingInvite}
              className="text-[13px] font-medium text-accent transition-colors hover:brightness-110"
            >
              Continue to your invitation →
            </Link>
          ) : (
            <Link
              to="/app"
              className="text-[13px] font-medium text-accent transition-colors hover:brightness-110"
            >
              Continue to the app →
            </Link>
          )}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          <Field label="Email address" htmlFor="verify-email">
            <input
              id="verify-email"
              type="email"
              required
              placeholder="Enter your email address"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              className={inputClass}
              autoComplete="username"
            />
          </Field>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <PrimaryButton type="submit" loading={submitting}>
            {sent ? "Resend verification link" : "Send verification link"}
          </PrimaryButton>
          <div className="mt-1 text-center">
            <Link to="/" className="text-[13px] text-muted hover:text-fg">
              ← Back to sign in
            </Link>
          </div>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-bg px-4 py-12 font-sans text-fg">
      <div className="relative w-full max-w-[440px] rounded-[14px] border border-border bg-surface px-7 pb-7 pt-8 shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
        <div className="flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-[10px] bg-white">
            <img src="/superlog-pictogram-dark.svg" alt="" aria-hidden="true" className="h-8 w-8" />
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputClass =
  "h-11 w-full rounded-[8px] border border-border bg-surface-2 px-3.5 text-[14px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5" htmlFor={htmlFor}>
      <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function PrimaryButton({
  type = "button",
  loading,
  children,
}: {
  type?: "button" | "submit";
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={loading}
      className="flex h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-accent text-[14px] font-semibold text-accent-ink transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span>{loading ? "…" : children}</span>
    </button>
  );
}
