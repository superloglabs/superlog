import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Solid colors use RGB-triplet vars (see index.css) so opacity
        // modifiers like bg-danger/20 actually work. The rgba-valued tokens
        // (border, accent-soft) can't take a modifier — use them as-is.
        bg: "rgb(var(--color-bg-rgb) / <alpha-value>)",
        surface: "rgb(var(--color-surface-rgb) / <alpha-value>)",
        "surface-2": "rgb(var(--color-surface-2-rgb) / <alpha-value>)",
        "surface-3": "rgb(var(--color-surface-3-rgb) / <alpha-value>)",
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        fg: "rgb(var(--color-fg-rgb) / <alpha-value>)",
        muted: "rgb(var(--color-muted-rgb) / <alpha-value>)",
        subtle: "rgb(var(--color-subtle-rgb) / <alpha-value>)",
        accent: "rgb(var(--color-accent-rgb) / <alpha-value>)",
        "accent-ink": "rgb(var(--color-accent-ink-rgb) / <alpha-value>)",
        "accent-soft": "var(--color-accent-soft)",
        danger: "rgb(var(--color-danger-rgb) / <alpha-value>)",
        warning: "rgb(var(--color-warning-rgb) / <alpha-value>)",
        success: "rgb(var(--color-success-rgb) / <alpha-value>)",
      },
      borderRadius: {
        xs: "1px",
        sm: "2px",
        DEFAULT: "4px",
        md: "6px",
        lg: "10px",
        xl: "12px",
        "2xl": "14px",
      },
      letterSpacing: {
        tightest: "-0.04em",
        tighter: "-0.025em",
        tight: "-0.015em",
      },
      boxShadow: {
        "inset-hairline":
          "inset 0 1px 0 0 rgba(255,255,255,0.04), inset 0 0 0 1px rgba(255,255,255,0.02)",
        "inset-deep": "inset 0 2px 4px 0 rgba(0,0,0,0.6), inset 0 1px 0 0 rgba(255,255,255,0.03)",
        "lift-sm":
          "0 1px 0 0 rgba(255,255,255,0.05) inset, 0 1px 2px 0 rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)",
        "lift-md":
          "0 1px 0 0 rgba(255,255,255,0.06) inset, 0 2px 8px -1px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)",
        "glow-accent": "0 0 0 1px rgba(72,90,226,0.35), 0 0 24px -4px rgba(72,90,226,0.42)",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "0.4", transform: "scale(0.95)" },
          "50%": { opacity: "1", transform: "scale(1.05)" },
        },
        scan: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
        scan: "scan 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
