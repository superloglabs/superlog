import type { ReactNode } from "react";
import { Wordmark } from "./design/ui.tsx";

const SECURITY_EMAIL = "security@superlog.sh";
const LEGAL_EMAIL = "legal@superlog.sh";

export function SecurityPolicyPage() {
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
            Superlog Security Policy
          </h1>

          <div className="mt-12 space-y-10 text-[15px] leading-7 text-muted md:text-[16px]">
            <Section>
              <p>
                This page describes the technical and organizational measures Pulsent Labs Inc.
                ("Superlog") uses to protect Customer Content and personal information. It is the
                Security Policy referenced by the{" "}
                <PageLink href="/tos">Terms of Service</PageLink> and the{" "}
                <PageLink href="/dpa">Data Processing Agreement</PageLink>, and we update it as our
                practices evolve.
              </p>
            </Section>

            <Section title="Infrastructure and Network">
              <p>
                Superlog runs on Amazon Web Services in the United States. Databases and telemetry
                stores are deployed in private subnets with no public network access, reachable only
                from the application services that need them through security-group rules.
                Administrative access to production systems requires a private network connection
                and is limited to authorized personnel.
              </p>
              <p>
                Infrastructure is defined and version-controlled as code, and changes to production
                configuration are applied through reviewed, automated deployments.
              </p>
            </Section>

            <Section title="Encryption">
              <p>
                All data is encrypted in transit using TLS 1.2 or higher (with TLS 1.3 supported);
                unencrypted connections are not accepted. Data is encrypted at rest using AES-256
                across our databases, telemetry stores, and backups via AWS-managed encryption.
              </p>
            </Section>

            <Section title="Authentication and Access Control">
              <p>
                Users sign in with GitHub OAuth, Google OAuth, or an email magic link, so Superlog
                stores no passwords. Sessions are protected with secure, expiring tokens. Access to
                Customer Content is scoped to the customer's workspace: each workspace's data is
                accessible only to its authorized members, according to their roles.
              </p>
            </Section>

            <Section title="Backups and Recovery">
              <p>
                Primary databases have automated daily backups with a 14-day retention window and
                support point-in-time recovery. Telemetry stores are backed up to encrypted object
                storage. Backups allow restoration of availability and access following a physical
                or technical incident.
              </p>
            </Section>

            <Section title="Data Retention and Deletion">
              <p>
                Ingested telemetry is retained according to the customer's plan and settings and
                deleted thereafter. When an account is terminated, Customer Content is deleted
                within 30 days. Customers can request an export of their data by contacting{" "}
                <PageLink href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</PageLink>.
              </p>
            </Section>

            <Section title="AI and Customer Content">
              <p>
                Superlog uses large language models to investigate issues and propose fixes. Model
                inference runs through the AI providers listed on our{" "}
                <PageLink href="/subprocessors">subprocessors page</PageLink> with training
                disabled: we do not use Customer Content to train foundation models, and our
                providers are not permitted to either.
              </p>
            </Section>

            <Section title="Subprocessors">
              <p>
                The third-party services that process Customer Content on our behalf are listed at{" "}
                <PageLink href="/subprocessors">superlog.sh/subprocessors</PageLink>, along with how
                we give notice of changes.
              </p>
            </Section>

            <Section title="Physical Security and Certifications">
              <p>
                Customer Content is processed exclusively in AWS data centers, whose physical
                security controls are maintained by AWS and covered by its compliance
                certifications, including SOC 2 and ISO 27001. Superlog does not yet hold its own
                SOC 2 or ISO 27001 certification; this page reflects our current practices, and we
                will update it as our security program matures.
              </p>
            </Section>

            <Section title="Reporting a Vulnerability">
              <p>
                If you believe you have found a security issue in Superlog, email{" "}
                <PageLink href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</PageLink>. We
                appreciate responsible disclosure and will respond as quickly as we can.
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
