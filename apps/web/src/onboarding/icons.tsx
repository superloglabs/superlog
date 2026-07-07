// Icons used by the dashboard todos. Inline SVGs sized to ~18px so they sit
// comfortably inside the indigo-tinted icon chip.
type IconProps = { size?: number; className?: string };

export function GithubIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.74-3.65 3.94.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function SlackIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
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
  );
}

export function TerminalIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
      <path d="m4 6 2 1.5L4 9M7.5 9h2.5" />
    </svg>
  );
}

export function BoltIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 1 2 8h4l-1 5 6-7H7l1-5Z" />
    </svg>
  );
}

export function ArrowIcon({ size = 13, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 7h8m-3-3 3 3-3 3" />
    </svg>
  );
}

export function ArrowLeftIcon({ size = 13, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M11 7H3m3-3-3 3 3 3" />
    </svg>
  );
}

export function CopyIcon({ size = 13, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M2 9V3a1.5 1.5 0 0 1 1.5-1.5H9" />
    </svg>
  );
}

export function SpinnerIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className={`animate-spin ${className ?? ""}`}
      aria-hidden="true"
    >
      <path d="M7 1.5a5.5 5.5 0 1 1-5.5 5.5" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m3 7.5 3 3 5-7" />
    </svg>
  );
}

export function InfoIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.6" />
      <path d="M7 6.4v3" />
      <circle cx="7" cy="4.4" r="0.2" fill="currentColor" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 13, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 2h4v4M12 2 6.5 7.5M11 8.5V11a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 2 11V5a1.5 1.5 0 0 1 1.5-1.5H6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Connect-source glyphs. Neutral monochrome line icons (currentColor) so no
// per-integration brand color competes for attention on the chooser.
// ---------------------------------------------------------------------------

// AWS — a stack of server racks. Deliberately distinct from a cloud so it
// doesn't read the same as the Cloudflare glyph (design open decision).
export function AwsIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="13" height="4.5" rx="1.2" />
      <rect x="2.5" y="11" width="13" height="4.5" rx="1.2" />
      <path d="M5 4.75h.01M5 13.25h.01M12.5 4.75h.5M12.5 13.25h.5" />
    </svg>
  );
}

// OpenTelemetry / SDK — a hexagon mark.
export function OtelIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 1.8 15.2 5.4v7.2L9 16.2 2.8 12.6V5.4Z" />
      <circle cx="9" cy="9" r="2.4" />
    </svg>
  );
}

// Coding agent — a sparkle.
export function AgentSparkIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 2.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8-.4-2.9-1.9-4.4-4.8-4.8C7.1 6.6 8.6 5.1 9 2.2Z" />
      <path d="M13.7 11.4c.2 1.3.9 2 2.1 2.2-1.2.2-1.9.9-2.1 2.2-.2-1.3-.9-2-2.1-2.2 1.2-.2 1.9-.9 2.1-2.2Z" />
    </svg>
  );
}

export function VercelIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 3.5 15.5 14.5h-13Z" />
    </svg>
  );
}

export function RailwayIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      {/* Simplified Railway mark: a rail curving through a window. */}
      <path d="M2.5 7.5h6.8a2.6 2.6 0 0 1 2.6 2.6v5.4" />
      <path d="M2.9 11h3.4" />
      <path d="M4 14h2.6" />
      <path d="M2.7 4.5h7.2a5.6 5.6 0 0 1 5.6 5.6v5.4" />
    </svg>
  );
}

export function KubernetesIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 1.9 15 4.8l-1.5 6.5L9 16.1 4.5 11.3 3 4.8Z" />
      <circle cx="9" cy="8.6" r="2.1" />
    </svg>
  );
}

// Cloudflare — a cloud outline (intentionally cloud-shaped, unlike the AWS rack).
export function CloudflareIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M5.2 13h7.3a2.6 2.6 0 0 0 .3-5.18A3.8 3.8 0 0 0 5.5 7.2 3 3 0 0 0 5.2 13Z" />
    </svg>
  );
}

export function GithubActionsIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="6.3" />
      <path d="m7.2 6.6 3.4 2.4-3.4 2.4Z" />
    </svg>
  );
}
