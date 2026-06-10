import { type FormEvent, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { authClient } from "./auth-client.ts";

// Two-step auth form. Step 1: enter email (or click a social provider). Step 2:
// enter password (sign-in) or name + password (sign-up). The previously-used
// provider gets a "Last used" pill so returning users land on the right
// button. Replaces Clerk's prebuilt <SignIn> / <SignUp>.

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100";
const LAST_PROVIDER_KEY = "superlog.auth.last_provider";

type Mode = "sign-in" | "sign-up";
type Step = "email" | "credentials";
type Provider = "email" | "google" | "github";

function readLastProvider(): Provider | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(LAST_PROVIDER_KEY);
    if (v === "email" || v === "google" || v === "github") return v;
  } catch {
    /* ignore */
  }
  return null;
}

function rememberProvider(p: Provider) {
  try {
    window.localStorage.setItem(LAST_PROVIDER_KEY, p);
  } catch {
    /* ignore */
  }
}

// Reports which social providers have credentials configured server-side, so
// the form can hide buttons that would 503 on click (e.g. worktree envs with
// no GOOGLE_CLIENT_ID / GITHUB_CLIENT_ID).
type ProvidersInfo = { google: boolean; github: boolean };

function useAuthProviders(): ProvidersInfo {
  const query = useQuery({
    queryKey: ["auth-providers"],
    queryFn: async (): Promise<ProvidersInfo> => {
      const res = await fetch(`${API_URL}/api/auth-providers`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as ProvidersInfo;
    },
    // Until the response lands, assume nothing is configured — better to
    // render no social buttons for half a tick than to flash a broken one.
    staleTime: 60_000,
  });
  return query.data ?? { google: false, github: false };
}

export function AuthForm({
  initialMode = "sign-in",
  onSuccess,
  onClose,
}: {
  initialMode?: Mode;
  onSuccess?: () => void;
  onClose?: () => void;
}) {
  const providers = useAuthProviders();
  const anySocial = providers.google || providers.github;
  const [mode, setMode] = useState<Mode>(initialMode);
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const lastProvider = useRef<Provider | null>(readLastProvider());
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "email") emailRef.current?.focus();
    else passwordRef.current?.focus();
  }, [step]);

  function onEmailSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!/.+@.+\..+/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setStep("credentials");
  }

  async function onCredentialsSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "sign-up") {
        const result = await authClient.signUp.email({
          email,
          password,
          name: name || email.split("@")[0] || "",
        });
        if (result.error) {
          setError(result.error.message ?? "Sign-up failed");
          return;
        }
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) {
          setError(result.error.message ?? "Sign-in failed");
          return;
        }
      }
      rememberProvider("email");
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  async function onGoogle() {
    setError(null);
    rememberProvider("google");
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: `${window.location.origin}/`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
    }
  }

  async function onGithub() {
    setError(null);
    rememberProvider("github");
    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: `${API_URL}/api/github/post-signin`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub sign-in failed");
    }
  }

  const title =
    mode === "sign-up"
      ? step === "email"
        ? "Create your Superlog account"
        : "Almost there"
      : step === "email"
        ? "Sign in to Superlog"
        : "Enter your password";
  const subtitle =
    mode === "sign-up"
      ? step === "email"
        ? "Logs, traces, metrics, and a fix agent — all from one prompt."
        : `Setting up ${email}`
      : step === "email"
        ? "Welcome back! Please sign in to continue"
        : `Signing in as ${email}`;

  return (
    <div className="relative w-full max-w-[440px] rounded-[14px] border border-border bg-surface px-7 pb-7 pt-8 shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
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
      <h1 className="mt-5 text-center text-[22px] font-semibold tracking-[-0.015em] text-fg">
        {title}
      </h1>
      <p className="mt-2 text-center text-[14px] leading-relaxed text-muted">{subtitle}</p>

      {step === "email" ? (
        <>
          {anySocial && (
            <div className="mt-6 flex flex-col gap-2">
              {providers.google && (
                <SocialButton
                  provider="google"
                  lastUsed={lastProvider.current === "google"}
                  onClick={onGoogle}
                />
              )}
              {providers.github && (
                <SocialButton
                  provider="github"
                  lastUsed={lastProvider.current === "github"}
                  onClick={onGithub}
                />
              )}
            </div>
          )}

          {anySocial ? <Divider /> : <div className="mt-6" />}

          <form onSubmit={onEmailSubmit} className="flex flex-col gap-4">
            <Field label="Email address">
              <input
                ref={emailRef}
                type="email"
                required
                placeholder="Enter your email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                autoComplete={mode === "sign-up" ? "email" : "username"}
              />
            </Field>
            {error && <p className="text-[13px] text-danger">{error}</p>}
            <PrimaryButton type="submit">Continue</PrimaryButton>
          </form>
        </>
      ) : (
        <form onSubmit={onCredentialsSubmit} className="mt-6 flex flex-col gap-4">
          {mode === "sign-up" && (
            <Field label="Your name (optional)">
              <input
                type="text"
                placeholder="Pat Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                autoComplete="name"
              />
            </Field>
          )}
          <Field label="Password">
            <input
              ref={passwordRef}
              type="password"
              required
              minLength={8}
              placeholder={mode === "sign-up" ? "8+ characters" : "Enter your password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            />
          </Field>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setStep("email");
                setPassword("");
                setError(null);
              }}
              className="text-[13px] text-muted hover:text-fg"
            >
              ← Use a different email
            </button>
            {mode === "sign-in" && (
              <Link to="/forgot-password" className="text-[13px] text-muted hover:text-fg">
                Forgot password?
              </Link>
            )}
          </div>
          <PrimaryButton type="submit" loading={submitting}>
            {mode === "sign-up" ? "Create account" : "Sign in"}
          </PrimaryButton>
        </form>
      )}

      <p className="mt-7 border-t border-border pt-5 text-center text-[13px] text-muted">
        {mode === "sign-up" ? "Already have an account? " : "Don't have an account? "}
        <button
          type="button"
          onClick={() => {
            setMode(mode === "sign-up" ? "sign-in" : "sign-up");
            setStep("email");
            setError(null);
          }}
          className="font-medium text-accent transition-colors hover:brightness-110"
        >
          {mode === "sign-up" ? "Sign in" : "Sign up"}
        </button>
      </p>
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
      className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent text-[14px] font-semibold text-accent-ink shadow-[0_1px_0_0_rgba(255,255,255,0.12)_inset,0_6px_14px_-6px_rgba(72,90,226,0.55)] transition-[filter] hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span>{loading ? "…" : children}</span>
      {!loading && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M9 6l6 6-6 6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

function SocialButton({
  provider,
  lastUsed,
  onClick,
}: {
  provider: "google" | "github";
  lastUsed: boolean;
  onClick: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        className="flex h-11 w-full items-center justify-center gap-3 rounded-[8px] border border-border bg-surface-2 text-[14px] font-medium text-fg transition-colors hover:bg-surface-3"
      >
        {provider === "google" ? <GoogleGlyph /> : <GithubGlyph />}
        <span>Continue with {provider === "google" ? "Google" : "GitHub"}</span>
      </button>
      {lastUsed && (
        <span className="pointer-events-none absolute -top-2.5 right-3 rounded-full border border-border bg-surface-3 px-2 py-0.5 text-[10.5px] font-medium text-muted">
          Last used
        </span>
      )}
    </div>
  );
}

function Divider() {
  return (
    <div className="my-5 flex items-center gap-3 text-[12px] text-subtle">
      <div className="h-px flex-1 bg-border" />
      <span>or</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M9 3.5c1.6 0 3 .55 4.1 1.6L16.05 2.2A8.85 8.85 0 0 0 9 0a9 9 0 0 0-8.05 5l3.45 2.65A5.45 5.45 0 0 1 9 3.5z"
      />
      <path
        fill="#4285F4"
        d="M17.65 9.2c0-.65-.06-1.27-.18-1.85H9V11h4.95a4.25 4.25 0 0 1-1.85 2.8l3.4 2.55C17.5 14.45 17.65 12 17.65 9.2z"
      />
      <path
        fill="#FBBC05"
        d="M4.4 10.65A5.46 5.46 0 0 1 4.1 9c0-.6.1-1.18.3-1.65L0.95 4.7A8.95 8.95 0 0 0 0 9c0 1.45.35 2.83.95 4.05l3.45-2.4z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.4 0 4.45-.8 5.95-2.15l-3.4-2.55c-.95.65-2.15 1-2.55 1A5.45 5.45 0 0 1 4.4 10.65L0.95 13.05A9 9 0 0 0 9 18z"
      />
    </svg>
  );
}

function GithubGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}
