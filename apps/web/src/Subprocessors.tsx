import type { ReactNode } from "react";
import { Wordmark } from "./design/ui.tsx";

const LEGAL_EMAIL = "legal@superlog.sh";

const SUBPROCESSORS = [
  {
    name: "Amazon Web Services",
    purpose: "Cloud infrastructure, data storage, and content delivery",
    location: "United States",
  },
  {
    name: "Anthropic",
    purpose: "AI model inference for investigation and remediation agents",
    location: "United States",
  },
  {
    name: "Stripe",
    purpose: "Payment processing and billing",
    location: "United States",
  },
  {
    name: "Resend",
    purpose: "Transactional email delivery",
    location: "United States",
  },
  {
    name: "Loops",
    purpose: "Product and lifecycle email",
    location: "United States",
  },
  {
    name: "PostHog",
    purpose: "Product analytics",
    location: "European Union",
  },
];

export function Subprocessors() {
  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="sticky top-0 z-40 border-b border-border bg-bg">
        <div className="mx-auto flex w-full max-w-[980px] items-center justify-between px-4 py-5 md:px-8">
          <a href="/" aria-label="Superlog home">
            <Wordmark />
          </a>
          <a
            href="/dpa"
            className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
          >
            DPA
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[980px] px-4 py-14 md:px-8 md:py-20">
        <article className="max-w-[780px]">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle">
            Last Updated: September 1, 2026
          </p>
          <h1
            className="mt-5 text-[2.25rem] leading-tight tracking-tight text-fg md:text-[3.75rem]"
            style={{ fontWeight: 450 }}
          >
            Superlog Subprocessors
          </h1>

          <div className="mt-12 space-y-10 text-[15px] leading-7 text-muted md:text-[16px]">
            <Section>
              <p>
                Pulsent Labs Inc. ("Superlog") uses the third-party subprocessors below to help
                provide the Service. Each subprocessor processes Customer Content or personal
                information only for the purpose listed, under a written agreement with data
                protection obligations. This is the subprocessor list referenced by the{" "}
                <PageLink href="/dpa">Data Processing Agreement</PageLink>.
              </p>
            </Section>

            <Section title="Current Subprocessors">
              {SUBPROCESSORS.map((subprocessor) => (
                <TermRow key={subprocessor.name} label={subprocessor.name}>
                  <div className="space-y-1">
                    <p>{subprocessor.purpose}</p>
                    <p className="text-subtle">{subprocessor.location}</p>
                  </div>
                </TermRow>
              ))}
            </Section>

            <Section title="Changes to This List">
              <p>
                Before adding or replacing a subprocessor, we will give customers at least 10
                business days' notice by emailing workspace administrators, as described in the{" "}
                <PageLink href="/dpa">Data Processing Agreement</PageLink>. Questions about this
                list can be sent to{" "}
                <PageLink href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</PageLink>.
              </p>
            </Section>
          </div>
        </article>
      </main>
    </div>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-5 border-t border-border pt-8 first:border-t-0 first:pt-0">
      {title && <h2 className="text-[24px] font-semibold tracking-tight text-fg">{title}</h2>}
      {children}
    </section>
  );
}

function TermRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 border-t border-border pt-5 first:border-t-0 first:pt-0 md:grid-cols-[210px_1fr]">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-subtle">{label}</div>
      <div className="text-muted">{children}</div>
    </div>
  );
}

function PageLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="text-fg underline decoration-border underline-offset-4 transition-colors hover:decoration-fg"
    >
      {children}
    </a>
  );
}
