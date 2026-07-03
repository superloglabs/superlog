import type { ReactNode } from "react";
import { Wordmark } from "./design/ui.tsx";

const CONTACT_EMAIL = "legal@superlog.sh";

export function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="sticky top-0 z-40 border-b border-border bg-bg">
        <div className="mx-auto flex w-full max-w-[980px] items-center justify-between px-4 py-5 md:px-8">
          <a href="/" aria-label="Superlog home">
            <Wordmark />
          </a>
          <a
            href="/tos"
            className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
          >
            Terms
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[980px] px-4 py-14 md:px-8 md:py-20">
        <article className="max-w-[780px]">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle">
            Last Updated: July 3, 2026
          </p>
          <h1
            className="mt-5 text-[2.25rem] leading-tight tracking-tight text-fg md:text-[3.75rem]"
            style={{ fontWeight: 450 }}
          >
            Pulsent Labs Inc. Privacy Policy
          </h1>

          <div className="mt-12 space-y-10 text-[15px] leading-7 text-muted md:text-[16px]">
            <Section>
              <p>
                This Privacy Policy explains how Pulsent Labs Inc. ("Superlog", "we", "us", or
                "our") collects, uses, discloses, and protects personal information when you visit
                our websites, create an account, use Superlog, connect third-party services, contact
                us, or otherwise interact with us.
              </p>
              <p>
                Superlog is an observability and agentic debugging platform. Customers decide what
                telemetry, repository metadata, cloud-resource metadata, tickets, Slack messages,
                and other content they send to or connect with Superlog. If you use Superlog through
                an organization, that organization controls the Customer Content it submits and may
                manage your access to it.
              </p>
            </Section>

            <Section title="Personal Information We Collect">
              <TermRow label="Account">
                Name, email address, password-derived authentication data, profile image, account
                preferences, organization membership, role, invitations, and session information.
              </TermRow>
              <TermRow label="Customer Content">
                Telemetry and operational data sent to Superlog, including traces, logs, metrics,
                exceptions, stack traces, service names, resource attributes, environment names,
                project metadata, source-map data, incident notes, project context, agent memories,
                feedback, and any personal information included in that content.
              </TermRow>
              <TermRow label="Integrations">
                Information we receive when you connect services such as GitHub, Slack, Linear, AWS,
                and Cloudflare. This may include repository names, pull requests, issues, commit
                metadata, installation identifiers, workspace or channel names, cloud account or
                resource metadata, ticket metadata, and integration tokens or credentials.
              </TermRow>
              <TermRow label="Billing">
                Plan, usage, invoice, subscription, and payment status information. Payment card
                details are handled by our payment processor and are not stored directly by
                Superlog.
              </TermRow>
              <TermRow label="Communications">
                Emails, support requests, feedback, survey responses, calendar bookings, and other
                messages you send to us or receive from us.
              </TermRow>
              <TermRow label="Usage">
                Product events, page views, referrers, UTM parameters, device and browser
                information, IP address, approximate location derived from IP address, cookies,
                identifiers, logs, and diagnostics about how the service is accessed and used.
              </TermRow>
            </Section>

            <Section title="How We Use Personal Information">
              <List>
                <li>Provide, operate, secure, monitor, and improve Superlog.</li>
                <li>Create and manage accounts, organizations, projects, roles, and sessions.</li>
                <li>Ingest, store, search, analyze, summarize, and display Customer Content.</li>
                <li>
                  Investigate incidents, generate recommendations, open pull requests or tickets,
                  and send notifications when you configure Superlog to do so.
                </li>
                <li>Connect and maintain integrations you authorize.</li>
                <li>Measure usage, enforce quotas, process payments, and administer billing.</li>
                <li>Send service, security, support, onboarding, and product communications.</li>
                <li>
                  Debug errors, prevent abuse, detect security incidents, and enforce agreements.
                </li>
                <li>
                  Comply with legal obligations and protect our rights, users, and the public.
                </li>
              </List>
            </Section>

            <Section title="Cookies And Analytics">
              <p>
                We use cookies and similar technologies for authentication, security, preferences,
                analytics, attribution, and product measurement. Some cookies are necessary for the
                service to work. Where analytics is enabled, we use it to understand product usage
                and improve Superlog, not to serve third-party behavioral advertising.
              </p>
              <p>
                Your browser may let you block or delete cookies. If you disable necessary cookies,
                parts of Superlog may not work.
              </p>
            </Section>

            <Section title="How We Disclose Personal Information">
              <List>
                <li>
                  Service providers and subprocessors that host, store, secure, analyze, support,
                  bill, email, or otherwise help us run Superlog.
                </li>
                <li>
                  Integration providers, such as GitHub, Slack, Linear, AWS, and Cloudflare, when
                  you connect them or instruct Superlog to interact with them.
                </li>
                <li>
                  Other users in your organization, according to their roles and the projects they
                  can access.
                </li>
                <li>
                  Professional advisers, auditors, insurers, and legal or regulatory authorities
                  when needed for business, compliance, security, or legal reasons.
                </li>
                <li>
                  A successor or prospective successor in a merger, acquisition, financing,
                  reorganization, or similar transaction, subject to appropriate protections.
                </li>
              </List>
              <p>
                We do not sell personal information or share it for cross-context behavioral
                advertising. We do not use Customer Content to train foundation models unless you
                separately agree to that use.
              </p>
            </Section>

            <Section title="Customer Content And Sensitive Data">
              <p>
                Superlog is designed to process operational telemetry and developer workflow data.
                You should avoid sending secrets, credentials, payment card numbers, health
                information, government identifiers, or other sensitive personal information in
                telemetry, logs, stack traces, prompts, project context, or integration content.
              </p>
              <p>
                If Customer Content contains personal information, we process it to provide Superlog
                to the customer and according to the customer's configuration and instructions.
              </p>
            </Section>

            <Section title="Retention">
              <p>
                We keep personal information for as long as needed to provide Superlog, comply with
                legal obligations, resolve disputes, enforce agreements, maintain security, and
                operate our business. Telemetry and other Customer Content are retained according to
                the customer's plan, settings, and deletion requests. Integration tokens are kept
                until the integration is disconnected or the token is replaced, unless a longer
                period is required for security, backup, or legal reasons.
              </p>
              <p>
                Backups and logs may persist for a limited period after deletion from active
                systems. Content already sent to third-party integrations, such as pull requests,
                tickets, or Slack messages, must usually be managed in those third-party services.
              </p>
            </Section>

            <Section title="Security">
              <p>
                We use administrative, technical, and organizational safeguards designed to protect
                personal information. No online service can guarantee absolute security. Please keep
                your credentials confidential, use strong authentication practices, and configure
                integrations and telemetry pipelines carefully.
              </p>
              <p>
                To report a security issue, email{" "}
                <ExternalLink href="mailto:security@superlog.sh">security@superlog.sh</ExternalLink>
                .
              </p>
            </Section>

            <Section title="International Data Transfers">
              <p>
                We may process and store personal information in the United States and other
                countries where we or our service providers operate. Those countries may have data
                protection laws that differ from the laws where you live. When required, we use
                appropriate transfer safeguards.
              </p>
            </Section>

            <Section title="Your Choices And Rights">
              <p>
                Depending on where you live, you may have rights to request access, correction,
                deletion, portability, restriction, or objection to certain processing of your
                personal information. You may also have the right to opt out of certain disclosures
                or to appeal a decision we make about your request.
              </p>
              <p>
                You can access and update some information in the product. To make a privacy
                request, email{" "}
                <ExternalLink href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</ExternalLink>. We
                may need to verify your identity and may direct organization-managed requests to the
                relevant customer administrator when appropriate.
              </p>
              <p>
                You may unsubscribe from marketing emails by using the unsubscribe link in those
                emails. We may still send transactional, security, billing, and service messages.
              </p>
            </Section>

            <Section title="Children">
              <p>
                Superlog is not directed to children, and we do not knowingly collect personal
                information from children under 13. If you believe a child has provided personal
                information to us, contact us so we can take appropriate action.
              </p>
            </Section>

            <Section title="Changes">
              <p>
                We may update this Privacy Policy from time to time. If we make material changes, we
                will provide notice as required by law, such as by updating this page, emailing
                account administrators, or showing an in-product notice.
              </p>
            </Section>

            <Section title="Contact">
              <p>
                Questions or privacy requests can be sent to{" "}
                <ExternalLink href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</ExternalLink>.
              </p>
              <p>Pulsent Labs Inc.</p>
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

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-3 pl-5 marker:text-subtle">{children}</ul>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target={href.startsWith("mailto:") ? undefined : "_blank"}
      rel={href.startsWith("mailto:") ? undefined : "noreferrer"}
      className="text-fg underline decoration-border underline-offset-4 transition-colors hover:decoration-fg"
    >
      {children}
    </a>
  );
}
