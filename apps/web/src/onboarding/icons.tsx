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

// Vercel — the official mark (a solid triangle), monochrome via currentColor.
export function VercelIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="m12 1.608 12 20.784H0Z" />
    </svg>
  );
}

// Railway — the official mark (Simple Icons, CC0), monochrome via currentColor.
export function RailwayIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M.113 10.27A13.026 13.026 0 000 11.48h18.23c-.064-.125-.15-.237-.235-.347-3.117-4.027-4.793-3.677-7.19-3.78-.8-.034-1.34-.048-4.524-.048-1.704 0-3.555.005-5.358.01-.234.63-.459 1.24-.567 1.737h9.342v1.216H.113v.002zm18.26 2.426H.009c.02.326.05.645.094.961h16.955c.754 0 1.179-.429 1.315-.96zm-17.318 4.28s2.81 6.902 10.93 7.024c4.855 0 9.027-2.883 10.92-7.024H1.056zM11.988 0C7.5 0 3.593 2.466 1.531 6.108l4.75-.005v-.002c3.71 0 3.849.016 4.573.047l.448.016c1.563.052 3.485.22 4.996 1.364.82.621 2.007 1.99 2.712 2.965.654.902.842 1.94.396 2.934-.408.914-1.289 1.458-2.353 1.458H.391s.099.42.249.886h22.748A12.026 12.026 0 0024 12.005C24 5.377 18.621 0 11.988 0z" />
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

// Cloudflare — the official mark (Simple Icons, CC0), monochrome via currentColor.
export function CloudflareIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" />
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
