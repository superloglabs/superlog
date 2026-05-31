import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { authClient } from "./auth-client.ts";

// /forgot-password — request a password reset email. Better Auth's
// requestPasswordReset endpoint deliberately returns the same "if this email
// exists" message whether or not the address is on file, so we mirror that in
// the UI and just confirm the email was sent. The user clicks the link in the
// email, lands on /reset-password?token=… (after BA validates the token),
// where they enter a new password.

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!/.+@.+\..+/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (result.error) {
        setError(result.error.message ?? "Couldn't send reset email.");
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
        {sent ? "Check your email" : "Reset your password"}
      </h1>
      <p className="mt-2 text-center text-[14px] leading-relaxed text-muted">
        {sent
          ? `If an account exists for ${email}, we've sent a link to reset your password.`
          : "Enter the email you signed up with and we'll send you a reset link."}
      </p>

      {sent ? (
        <div className="mt-7 flex flex-col items-center gap-3">
          <Link
            to="/"
            className="text-[13px] font-medium text-accent transition-colors hover:brightness-110"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          <Field label="Email address">
            <input
              type="email"
              required
              autoFocus
              placeholder="Enter your email address"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              className={inputClass}
              autoComplete="username"
            />
          </Field>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <PrimaryButton type="submit" loading={submitting}>
            Send reset link
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
            <img
              src="/superlog-pictogram-dark.svg"
              alt=""
              aria-hidden="true"
              className="h-8 w-8"
            />
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputClass =
  "h-11 w-full rounded-[8px] border border-border bg-surface-2 px-3.5 text-[14px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
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
