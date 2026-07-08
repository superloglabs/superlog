import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Canonical shared primitives — used across the app and the /design sheet.
// Dark canvas · cobalt accent · soft corners (6px buttons, 10px inputs,
// 10-12px cards).
//
// Rules + catalog: apps/web/DESIGN.md. Live reference: /design
// (DesignLanguage.tsx). Changing a primitive here? Update its panel on the
// /design sheet too — the sheet is how we catch drift. No mono caps: labels are
// capitalized sans (Label/FieldLabel below are legacy mono-caps, being retired).
// ---------------------------------------------------------------------------

export function ShortcutKey({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border bg-surface-2 px-1 font-mono text-[10px] text-muted ${className}`}
    >
      {children}
    </kbd>
  );
}

export function Tile({
  children,
  className = "",
  label,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`relative rounded-lg border border-border bg-surface ${padded ? "p-5" : ""} ${className}`}
    >
      {label && (
        <div className="mb-4 flex items-center justify-between">
          <Label>{label}</Label>
        </div>
      )}
      {children}
    </div>
  );
}

export function SkeletonBlock({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      style={style}
      className={`block rounded-sm bg-surface-2 motion-safe:animate-pulse ${className}`}
    />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">{children}</span>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
      {children}
    </label>
  );
}

export function Arrow() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type BtnProps = {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
};

export function Btn({
  children,
  variant = "primary",
  size = "md",
  disabled,
  loading,
  className = "",
  type = "button",
  onClick,
}: BtnProps) {
  const base =
    "inline-flex items-center gap-2 rounded-md font-medium tracking-tight transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 select-none";
  const sizes = {
    sm: "h-7 px-2.5 text-[12px]",
    md: "h-8 px-3 text-[13px]",
    lg: "h-10 px-4 text-[14px]",
  };
  const variants = {
    primary:
      "bg-accent text-accent-ink hover:brightness-110 active:brightness-95 shadow-[0_1px_0_0_rgba(255,255,255,0.12)_inset,0_6px_14px_-6px_rgba(72,90,226,0.55)]",
    secondary: "bg-transparent text-fg border border-border hover:border-border-strong",
    ghost: "bg-transparent text-fg hover:bg-surface-2",
    danger: "bg-danger/20 text-danger hover:bg-danger/30 active:bg-danger/25",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {loading && (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export type ChipTone = "neutral" | "success" | "warning" | "danger" | "muted" | "accent";

export function Chip({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: ChipTone;
  dot?: boolean;
}) {
  const tones: Record<ChipTone, string> = {
    neutral: "bg-surface-2 text-fg",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-danger/15 text-danger",
    muted: "bg-surface-2 text-muted",
    accent: "bg-accent-soft text-accent",
  };
  const dotColor: Record<ChipTone, string> = {
    neutral: "bg-muted",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    muted: "bg-subtle",
    accent: "bg-accent",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-[11px] tabular-nums ${tones[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dotColor[tone]}`} />}
      {children}
    </span>
  );
}

// Rounded-pill segmented toggle. The selected option gets a raised pill;
// the rest are muted text on the shared track. Sans, no caps.
export function PillToggle({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: string;
  options: { value: string; label: ReactNode }[];
  onChange: (v: string) => void;
  size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "px-2.5 py-0.5 text-[12px]" : "px-3 py-1 text-[12.5px]";
  return (
    <div role="radiogroup" className="inline-flex items-center gap-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`rounded-full ${pad} transition-colors ${
              active ? "bg-surface-3 text-fg shadow-sm" : "text-muted hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Tab bar. Capitalized sans labels with no outer track — only the active tab
// gets a soft raised pill (surface-2 fill + hairline border); the rest are
// muted text that brightens on hover.
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1 text-[12px]";
  return (
    <div role="tablist" className="inline-flex items-center gap-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`rounded-full font-medium tracking-tight transition-colors ${pad} ${
              active ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-[13px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none ${className}`}
    />
  );
}

export function SearchInput({
  placeholder = "span.name contains 'checkout'",
  shortcut = "⌘K",
}: {
  placeholder?: string;
  shortcut?: string;
}) {
  return (
    <div className="relative">
      <svg
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-8 pr-16 font-mono text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
      />
      <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-muted">
        {shortcut}
      </span>
    </div>
  );
}

export function Select({ options }: { options: string[] }) {
  return (
    <div className="relative">
      <select
        defaultValue={options[0]}
        className="h-9 w-full appearance-none rounded-lg border border-border bg-surface-2 pl-3 pr-8 text-[13px] text-fg focus:border-border-strong focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-subtle"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric tile & sparkline
// ---------------------------------------------------------------------------

export function MetricTile({
  className = "",
  label,
  value,
  unit,
  delta,
  invert = false,
  sparkline = true,
}: {
  className?: string;
  label: string;
  value: string;
  unit?: string;
  delta?: number;
  invert?: boolean;
  sparkline?: boolean;
}) {
  const hasDelta = typeof delta === "number";
  const positive = hasDelta ? (invert ? (delta as number) < 0 : (delta as number) > 0) : true;
  const tone = positive ? "text-success" : "text-danger";
  const sign = hasDelta && (delta as number) > 0 ? "+" : "";
  return (
    <div className={`relative rounded-2xl border border-border bg-surface p-5 ${className}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">{label}</span>
        {hasDelta && (
          <span className={`font-mono text-[11px] tabular-nums ${tone}`}>
            {sign}
            {(delta as number).toFixed(2)}%
          </span>
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="font-sans text-4xl font-semibold tabular-nums tracking-tight text-fg">
          {value}
        </span>
        {unit && <span className="font-mono text-[11px] text-subtle">{unit}</span>}
      </div>
      {sparkline && <Sparkline className="mt-4" tone={positive ? "success" : "danger"} />}
    </div>
  );
}

export function Sparkline({
  className = "",
  tone = "success",
}: {
  className?: string;
  tone?: "success" | "danger" | "accent";
}) {
  const pts = [18, 22, 17, 25, 20, 28, 23, 31, 26, 35, 29, 33, 30, 38, 34, 41];
  const max = Math.max(...pts);
  const d = pts
    .map((y, i) => `${i === 0 ? "M" : "L"} ${(i / (pts.length - 1)) * 100} ${40 - (y / max) * 38}`)
    .join(" ");
  const color = tone === "success" ? "#41D195" : tone === "danger" ? "#EF5A6F" : "#485AE2";
  return (
    <svg
      className={className}
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      width="100%"
      height="40"
    >
      <defs>
        <linearGradient id={`sl-${tone}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L 100 40 L 0 40 Z`} fill={`url(#sl-${tone})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// App shell — shared chrome for signed-in and auth screens
// ---------------------------------------------------------------------------

export function AppShell({
  nav,
  children,
}: {
  nav?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg font-sans text-fg">
      {nav && (
        <header className="shrink-0 bg-bg">
          <div className="px-6">{nav}</div>
          <div className="h-px bg-border" />
        </header>
      )}
      <main className="relative flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

export function CenteredShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <main className="relative flex min-h-screen flex-col items-center justify-center px-6 py-12">
        {children}
      </main>
    </div>
  );
}

export function Wordmark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizes = {
    sm: "h-5 w-auto",
    md: "h-6 w-auto",
    lg: "h-8 w-auto",
  };
  const theme = useTheme();
  const src = theme === "light" ? "/superlog-wordmark-light.svg" : "/superlog-wordmark.svg";
  return <img src={src} alt="Superlog" className={sizes[size]} draggable={false} />;
}

export type Theme = "light" | "dark";

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function ThemeToggle() {
  const theme = useTheme();
  const next: Theme = theme === "dark" ? "light" : "dark";
  const apply = (t: Theme) => {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("theme", t);
    } catch (_) {}
  };
  return (
    <button
      type="button"
      onClick={() => apply(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="grid h-7 w-7 place-items-center border border-border text-muted transition-colors hover:text-fg"
    >
      {theme === "dark" ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
