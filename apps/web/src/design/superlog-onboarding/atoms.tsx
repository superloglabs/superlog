import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from "react";

// Self-contained primitives for the Superlog onboarding design demo.
// Uses local CSS vars defined on the playground root (`.sl-onb-root`).

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> & {
  children?: ReactNode;
  variant?: Variant;
  size?: Size;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
};

const btnBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  borderRadius: 8,
  fontWeight: 500,
  letterSpacing: "-0.005em",
  border: "1px solid transparent",
  cursor: "pointer",
  transition: "background 120ms ease, border-color 120ms ease, color 120ms ease, filter 120ms ease",
  whiteSpace: "nowrap",
  userSelect: "none",
  fontFamily: "inherit",
};

const sizeMap: Record<Size, CSSProperties> = {
  sm: { height: 30, padding: "0 10px", fontSize: 12 },
  md: { height: 36, padding: "0 14px", fontSize: 13 },
  lg: { height: 44, padding: "0 18px", fontSize: 14 },
};

const variantMap: Record<Variant, CSSProperties> = {
  primary: { background: "var(--sl-indigo)", color: "#fff", borderColor: "var(--sl-indigo)" },
  secondary: {
    background: "rgba(255,255,255,0.06)",
    color: "var(--sl-fg)",
    borderColor: "var(--sl-line)",
  },
  ghost: { background: "transparent", color: "var(--sl-fg-2)" },
  outline: {
    background: "transparent",
    color: "var(--sl-fg)",
    borderColor: "var(--sl-line-2)",
  },
  danger: { background: "transparent", color: "var(--sl-red)", borderColor: "var(--sl-line)" },
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  leftIcon,
  rightIcon,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  return (
    <button
      disabled={disabled}
      style={{
        ...btnBase,
        ...sizeMap[size],
        ...variantMap[variant],
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.filter = "brightness(1.1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "none";
      }}
      {...rest}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}

export function Card({
  children,
  style,
  onClick,
}: {
  children: ReactNode;
  style?: CSSProperties;
  onClick?: () => void;
}) {
  const baseStyle: CSSProperties = {
    background: "var(--sl-surface)",
    border: "1px solid var(--sl-line)",
    borderRadius: 12,
    ...style,
  };
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{
          ...baseStyle,
          textAlign: "left",
          font: "inherit",
          color: "inherit",
          cursor: "pointer",
          width: "100%",
        }}
      >
        {children}
      </button>
    );
  }
  return <div style={baseStyle}>{children}</div>;
}

export function Wordmark({ height = 18 }: { height?: number }) {
  return (
    <img
      src="/superlog-wordmark.svg"
      alt="Superlog"
      draggable={false}
      style={{ height, width: "auto", display: "inline-block" }}
    />
  );
}

export function Checkbox({
  checked,
  size = 16,
}: {
  checked: boolean;
  // Kept for API compatibility — pickers wrap the checkbox in an interactive
  // parent (button/row), so the checkbox itself is presentational.
  onChange?: (next: boolean) => void;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        border: `1px solid ${checked ? "var(--sl-indigo)" : "var(--sl-line-2)"}`,
        background: checked ? "var(--sl-indigo)" : "transparent",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        flexShrink: 0,
        transition: "all 120ms ease",
        cursor: "pointer",
      }}
    >
      {checked && I.check(size - 4)}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
}) {
  return (
    <span
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      onClick={() => onChange?.(!checked)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onChange?.(!checked);
        }
      }}
      style={{
        width: 30,
        height: 18,
        borderRadius: 9,
        background: checked ? "var(--sl-indigo)" : "rgba(255,255,255,0.12)",
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 120ms ease",
        display: "inline-block",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 14 : 2,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 120ms ease",
        }}
      />
    </span>
  );
}

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "size"> & {
  value: string;
  onChange?: (value: string) => void;
  leftIcon?: ReactNode;
  containerStyle?: CSSProperties;
};

export function TextInput({
  value,
  onChange,
  placeholder,
  leftIcon,
  containerStyle,
  ...rest
}: TextInputProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 36,
        padding: "0 12px",
        background: "var(--sl-bg-elev)",
        border: "1px solid var(--sl-line)",
        borderRadius: 8,
        transition: "border-color 120ms ease",
        ...containerStyle,
      }}
    >
      {leftIcon && <span style={{ color: "var(--sl-fg-3)", display: "flex" }}>{leftIcon}</span>}
      <input
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1,
          background: "transparent",
          border: 0,
          outline: "none",
          color: "var(--sl-fg)",
          fontSize: 13,
          fontFamily: "inherit",
          letterSpacing: "-0.005em",
          minWidth: 0,
        }}
        {...rest}
      />
    </div>
  );
}

// ─── Inline icons ──────────────────────────────────────────────────
const stroke = (s: number, path: ReactNode, w = 1.5) => (
  <svg
    width={s}
    height={s}
    viewBox={`0 0 ${s <= 12 ? 12 : 14} ${s <= 12 ? 12 : 14}`}
    fill="none"
    stroke="currentColor"
    strokeWidth={w}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

export const I = {
  github: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.74-3.65 3.94.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  ),
  slack: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 9.5a1.5 1.5 0 1 1-1.5-1.5h1.5v1.5Zm.75 0A1.5 1.5 0 0 1 5.75 8a1.5 1.5 0 0 1 1.5 1.5v3.75a1.5 1.5 0 0 1-3 0V9.5Z"
        fill="#E01E5A"
      />
      <path
        d="M5.75 3.5a1.5 1.5 0 1 1 1.5-1.5v1.5h-1.5Zm0 .75a1.5 1.5 0 0 1 0 3H2a1.5 1.5 0 1 1 0-3h3.75Z"
        fill="#36C5F0"
      />
      <path
        d="M11.75 5.75a1.5 1.5 0 1 1 1.5 1.5h-1.5v-1.5Zm-.75 0a1.5 1.5 0 0 1-3 0V2a1.5 1.5 0 1 1 3 0v3.75Z"
        fill="#2EB67D"
      />
      <path
        d="M9.5 11.75a1.5 1.5 0 1 1-1.5 1.5v-1.5h1.5Zm0-.75a1.5 1.5 0 0 1 0-3h3.75a1.5 1.5 0 0 1 0 3H9.5Z"
        fill="#ECB22E"
      />
    </svg>
  ),
  check: (s = 14) => stroke(s, <path d="m3 7.5 3 3 5-7" />, 1.6),
  arrow: (s = 14) => stroke(s, <path d="M3 7h8m-3-3 3 3-3 3" />, 1.6),
  arrowL: (s = 14) => stroke(s, <path d="M11 7H3m3-3-3 3 3 3" />, 1.6),
  copy: (s = 14) =>
    stroke(
      s,
      <>
        <rect x="4" y="4" width="8" height="8" rx="1.5" />
        <path d="M2 10V3a1 1 0 0 1 1-1h7" />
      </>,
    ),
  search: (s = 14) =>
    stroke(
      s,
      <>
        <circle cx="6" cy="6" r="4" />
        <path d="m9.5 9.5 2.5 2.5" />
      </>,
    ),
  spinner: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.6" />
      <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 7 7"
          to="360 7 7"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  ),
  dot: (s = 6) => (
    <svg width={s} height={s} viewBox="0 0 6 6" aria-hidden="true">
      <circle cx="3" cy="3" r="3" fill="currentColor" />
    </svg>
  ),
  x: (s = 12) => stroke(s, <path d="m3 3 6 6m0-6-6 6" />),
  plus: (s = 12) => stroke(s, <path d="M6 2v8M2 6h8" />),
  hash: (s = 14) => stroke(s, <path d="M5 1 4 13M10 1 9 13M1 5h12M1 10h12" />),
  lock: (s = 12) =>
    stroke(
      s,
      <>
        <rect x="2" y="5" width="8" height="6" rx="1" />
        <path d="M4 5V3.5a2 2 0 1 1 4 0V5" />
      </>,
    ),
  bolt: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <path d="M8 1 2 8h4l-1 5 6-7H7l1-5Z" />
    </svg>
  ),
  terminal: (s = 14) =>
    stroke(
      s,
      <>
        <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
        <path d="m4 6 2 1.5L4 9M7.5 9h2.5" />
      </>,
    ),
};
