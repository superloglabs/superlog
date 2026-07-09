import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "../design/ui.tsx";
import { LANDING_GITHUB_REPO_URL } from "../landingLinks.ts";

// Shared chrome for the public, unauthenticated content pages (changelog,
// roadmap). Mirrors the Landing / TermsOfService header + footer so these
// pages feel part of the marketing surface.

const NAV_LINKS: Array<{ href: string; label: string; external?: boolean }> = [
  { href: "/changelog", label: "Changelog" },
  { href: "/roadmap", label: "Roadmap" },
  { href: "/team", label: "Team" },
  { href: "/pricing", label: "Pricing" },
  { href: LANDING_GITHUB_REPO_URL, label: "GitHub", external: true },
];

export function PublicShell({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen overflow-x-clip bg-bg font-sans text-fg">
      <header className="sticky top-0 z-40 border-b border-border bg-bg">
        <div className="mx-auto flex w-full max-w-[1080px] items-center justify-between gap-4 px-4 py-5 md:px-8">
          <a href="/" aria-label="Superlog home" className="shrink-0">
            <Wordmark />
          </a>
          <nav className="flex min-w-0 w-32 items-center gap-5 overflow-x-auto [scrollbar-width:none] sm:w-auto [&::-webkit-scrollbar]:hidden">
            {NAV_LINKS.map((link) =>
              link.external ? (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-[12px] font-medium text-muted transition-colors hover:text-fg"
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  key={link.href}
                  to={link.href}
                  className="shrink-0 text-[12px] font-medium text-muted transition-colors hover:text-fg"
                >
                  {link.label}
                </Link>
              ),
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1080px] px-4 py-14 md:px-8 md:py-20">
        <div className="max-w-[780px]">
          {eyebrow && <p className="text-[13px] font-medium text-subtle">{eyebrow}</p>}
          <h1
            className="mt-5 break-words text-[2.25rem] leading-tight tracking-tight text-fg md:text-[3.25rem]"
            style={{ fontWeight: 450 }}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="mt-5 text-[15px] leading-7 text-muted md:text-[17px]">{subtitle}</p>
          )}
        </div>
        <div className="mt-14">{children}</div>
      </main>
    </div>
  );
}
