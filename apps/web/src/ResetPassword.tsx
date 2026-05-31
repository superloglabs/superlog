import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authClient } from "./auth-client.ts";

// /reset-password — the user lands here from the email link AFTER Better
// Auth's /api/auth/reset-password/:token endpoint has validated the token and
// 302'd here with `?token=…` (valid) or `?error=INVALID_TOKEN` (expired or
// tampered). We don't re-check the token client-side — POSTing newPassword +
// token to /api/auth/reset-password is the authoritative check; BA returns
// the same INVALID_TOKEN error if anything has changed since the redirect.

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const linkError = params.get("error");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenMissing = !token || linkError === "INVALID_TOKEN";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (!token) return;
    setSubmitting(true);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(result.error.message ?? "Couldn't reset password.");
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  if (tokenMissing) {
    return (
      <Shell>
        <h1 className="mt-5 text-center text-[22px] font-semibold tracking-[-0.015em] text-fg">
          Link expired
        </h1>
        <p className="mt-2 text-center text-[14px] leading-relaxed text-muted">
          This reset link is invalid or has expired. Request a new one to continue.
        </p>
        <div className="mt-7 flex flex-col items-center gap-3">
          <Link
            to="/forgot-password"
            className="text-[13px] font-medium text-accent transition-colors hover:brightness-110"
          >
            Request a new link
          </Link>
        </div>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <h1 className="mt-5 text-center text-[22px] font-semibold tracking-[-0.015em] text-fg">
          Password updated
        </h1>
        <p className="mt-2 text-center text-[14px] leading-relaxed text-muted">
          You can now sign in with your new password.
        </p>
        <div className="mt-7 flex flex-col items-center gap-3">
          <Link
            to="/"
            className="text-[13px] font-medium text-accent transition-colors hover:brightness-110"
          >
            Sign in
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="mt-5 text-center text-[22px] font-semibold tracking-[-0.015em] text-fg">
        Set a new password
      </h1>
      <p className="mt-2 text-center text-[14px] leading-relaxed text-muted">
        Choose a strong password you haven't used before.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <Field label="New password">
          <input
            type="password"
            required
            autoFocus
            minLength={8}
            placeholder="8+ characters"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            className={inputClass}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            required
            minLength={8}
            placeholder="Re-enter your new password"
            value={confirm}
            onChange={(ev) => setConfirm(ev.target.value)}
            className={inputClass}
            autoComplete="new-password"
          />
        </Field>
        {error && <p className="text-[13px] text-danger">{error}</p>}
        <PrimaryButton type="submit" loading={submitting}>
          Update password
        </PrimaryButton>
      </form>
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
