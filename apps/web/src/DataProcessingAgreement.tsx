import type { ReactNode } from "react";
import { Wordmark } from "./design/ui.tsx";

const COMMON_PAPER_DPA_URL = "https://commonpaper.com/standards/data-processing-agreement/1.1";
const TOS_URL = "https://superlog.sh/tos";
const SUBPROCESSORS_URL = "https://superlog.sh/subprocessors";
const SECURITY_URL = "https://superlog.sh/security";
const SECURITY_CONTACT_EMAIL = "legal@superlog.sh";

export function DataProcessingAgreement() {
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
            Last Updated: September 1, 2026
          </p>
          <h1
            className="mt-5 text-[2.25rem] leading-tight tracking-tight text-fg md:text-[3.75rem]"
            style={{ fontWeight: 450 }}
          >
            Pulsent Labs Inc. Data Processing Agreement
          </h1>

          <div className="mt-12 space-y-10 text-[15px] leading-7 text-muted md:text-[16px]">
            <Section title="Using This DPA">
              <p>
                This DPA has 2 parts: (1) the Key Terms below and (2) the{" "}
                <PageLink href={COMMON_PAPER_DPA_URL} external>
                  Common Paper DPA Standard Terms Version 1.1
                </PageLink>{" "}
                ("DPA Standard Terms"), which are incorporated by reference. If there is any
                inconsistency between the parts of the DPA, the Key Terms will control over the DPA
                Standard Terms. Capitalized words have the meanings given in the Key Terms. However,
                if the Key Terms omit or do not define a term used in the DPA Standard Terms, the
                default meaning will be "none" or "not applicable" and the correlating clause,
                sentence, or section does not apply to this DPA. All other capitalized words have the
                meanings given in the DPA Standard Terms or the Agreement.
              </p>
              <p>
                This DPA supplements the Agreement between Provider and Customer and is entered into
                when Customer accepts the Agreement.
              </p>
            </Section>

            <Section title="Key Terms">
              <TermRow label="Agreement">
                This DPA supplements the{" "}
                <PageLink href={TOS_URL}>Superlog Terms of Service</PageLink> or, if Customer has
                signed a separate agreement with Provider for the Service, that separate agreement.
              </TermRow>
              <TermRow label="Approved Subprocessors">
                The subprocessors listed at{" "}
                <PageLink href={SUBPROCESSORS_URL}>superlog.sh/subprocessors</PageLink>.
              </TermRow>
              <TermRow label="Provider Security Contact">
                <PageLink href={`mailto:${SECURITY_CONTACT_EMAIL}`}>
                  {SECURITY_CONTACT_EMAIL}
                </PageLink>
              </TermRow>
              <TermRow label="Security Policy">
                The security policy available at{" "}
                <PageLink href={SECURITY_URL}>superlog.sh/security</PageLink>.
              </TermRow>
              <TermRow label="Service Provider Relationship">
                To the extent California Consumer Privacy Act, Cal. Civ. Code § 1798.100 et seq
                ("CCPA") applies, the parties acknowledge and agree that Provider is a service
                provider and is receiving Personal Data from Customer to provide the Service as
                agreed in the Agreement and detailed below (see Nature and Purpose of Processing),
                which constitutes a limited and specified business purpose. Provider will not sell
                or share any Personal Data provided by Customer under the Agreement. In addition,
                Provider will not retain, use, or disclose any Personal Data provided by Customer
                under the Agreement except as necessary for providing the Service for Customer, as
                stated in the Agreement, or as permitted by Applicable Data Protection Laws.
                Provider certifies that it understands the restrictions of this paragraph and will
                comply with all Applicable Data Protection Laws. Provider will notify Customer if it
                can no longer meet its obligations under the CCPA.
              </TermRow>
              <TermRow label="Governing Member State">
                <div className="space-y-2">
                  <p>EEA Transfers: Ireland</p>
                  <p>UK Transfers: England and Wales</p>
                </div>
              </TermRow>
            </Section>

            <Section title="Annex I(A) — List of Parties">
              <TermRow label="Data Exporter">
                <div className="space-y-2">
                  <p>Name: the Customer entering into this DPA</p>
                  <p>Activities relevant to transfer: see Annex I(B)</p>
                  <p>Role: Controller</p>
                </div>
              </TermRow>
              <TermRow label="Data Importer">
                <div className="space-y-2">
                  <p>Name: Pulsent Labs Inc.</p>
                  <p>
                    Contact person: Nicolò Magnante, CEO,{" "}
                    <PageLink href={`mailto:${SECURITY_CONTACT_EMAIL}`}>
                      {SECURITY_CONTACT_EMAIL}
                    </PageLink>
                  </p>
                  <p>
                    Address: 1111B S Governors Ave # 88398, Dover, Delaware 19904, United States of
                    America
                  </p>
                  <p>Activities relevant to transfer: see Annex I(B)</p>
                  <p>Role: Processor</p>
                </div>
              </TermRow>
            </Section>

            <Section title="Annex I(B) — Description of Transfer and Processing Activities">
              <TermRow label="Service">
                Superlog, an AI-native observability platform that monitors Customer's applications
                by ingesting logs, errors, and telemetry from connected integrations, and uses AI
                agents to investigate issues and propose and apply bug fixes.
              </TermRow>
              <TermRow label="Categories of Data Subjects">
                <List>
                  <li>Customer's end users or customers</li>
                  <li>Customer's employees</li>
                </List>
              </TermRow>
              <TermRow label="Categories of Personal Data">
                <List>
                  <li>Name</li>
                  <li>Contact information such as email, phone number, or address</li>
                  <li>Transactional information such as account information or purchases</li>
                  <li>User activity and analysis such as device information or IP address</li>
                  <li>Location information</li>
                </List>
              </TermRow>
              <TermRow label="Special Category Data">
                Special category data (as defined in Article 9 of the GDPR) is not intended to be
                Processed, and Customer should not submit it to the Service.
              </TermRow>
              <TermRow label="Frequency of Transfer">Continuous</TermRow>
              <TermRow label="Nature and Purpose of Processing">
                <div className="space-y-4">
                  <p>
                    Provider will Process Customer Personal Data as instructed in Section 2.3 of the
                    DPA Standard Terms. The nature of processing includes:
                  </p>
                  <List>
                    <li>
                      Receiving data, including collection, accessing, retrieval, recording, and
                      data entry
                    </li>
                    <li>Holding data, including storage, organization, and structuring</li>
                    <li>
                      Using data, including analysis, consultation, testing, automated decision
                      making, and profiling
                    </li>
                    <li>Protecting data, including restricting, encrypting, and security testing</li>
                    <li>Returning data to the data exporter or data subject</li>
                    <li>Erasing data, including destruction and deletion</li>
                  </List>
                </div>
              </TermRow>
              <TermRow label="Duration of Processing">
                Provider will process Customer Personal Data as long as required (i) to conduct the
                Processing activities instructed in Section 2.2(a)-(d) of the DPA Standard Terms; or
                (ii) by Applicable Laws.
              </TermRow>
            </Section>

            <Section title="Annex I(C) — Competent Supervisory Authority">
              <p>
                The supervisory authority will be the supervisory authority of the data exporter, as
                determined in accordance with Clause 13 of the EEA SCCs or the relevant provision of
                the UK Addendum.
              </p>
            </Section>

            <Section title="Annex II — Technical and Organizational Security Measures">
              <p>
                See the <PageLink href={SECURITY_URL}>Security Policy</PageLink>. The measures
                include:
              </p>
              <TermRow label="Encryption">
                All Customer Personal Data is encrypted in transit using TLS 1.2 or higher and
                encrypted at rest using AES-256 via AWS-managed services.
              </TermRow>
              <TermRow label="Confidentiality, Integrity, Availability">
                Superlog maintains technical and organizational safeguards for Customer Personal
                Data, including encryption, access controls, and network isolation on AWS-managed
                infrastructure. Current practices are described in the{" "}
                <PageLink href={SECURITY_URL}>Security Policy</PageLink>.
              </TermRow>
              <TermRow label="Restore and Recovery">
                Customer data is stored in AWS-managed databases with automated backups and
                point-in-time recovery, enabling restoration of availability and access following a
                physical or technical incident.
              </TermRow>
              <TermRow label="Identification and Authorization">
                Access to Customer data requires an authenticated user account. Users sign in via
                GitHub OAuth, Google OAuth, or email magic link, so Superlog stores no passwords;
                sessions are protected with secure, expiring tokens, and each workspace's data is
                accessible only to its authorized members.
              </TermRow>
              <TermRow label="Protection in Transit">
                All Customer Personal Data is encrypted in transit using TLS 1.2 or higher;
                unencrypted connections are not accepted.
              </TermRow>
              <TermRow label="Protection at Rest">
                Customer Personal Data is encrypted at rest using AES-256 via AWS-managed storage
                services.
              </TermRow>
              <TermRow label="Physical Security">
                Customer Personal Data is processed exclusively in AWS data centers; physical
                security controls are maintained by AWS and covered by its compliance
                certifications.
              </TermRow>
              <TermRow label="Events Logging">
                System and application events, including access to production systems, are logged
                and retained for security monitoring and incident investigation.
              </TermRow>
              <TermRow label="Systems Configuration">
                Infrastructure is defined and version-controlled as code; changes to production
                configuration are applied through reviewed, automated deployments.
              </TermRow>
              <TermRow label="Limited Data Retention">
                Ingested Customer data is retained for the retention period of the Customer's plan
                and deleted thereafter; all Customer Personal Data is deleted following termination
                of the Agreement.
              </TermRow>
              <TermRow label="Portability and Erasure">
                Customers can export their data and can request deletion of Customer Personal Data;
                upon termination, all Customer Personal Data is deleted within 30 days. Superlog
                assists Customers in responding to data subject access and erasure requests
                concerning data held in the Service. Secure disposal of storage hardware is handled
                by AWS.
              </TermRow>
            </Section>

            <Section title="Changes">
              <p>
                Provider and Customer have not changed the DPA Standard Terms except for the details
                in the Key Terms above.
              </p>
              <p>
                Questions about this DPA can be sent to{" "}
                <PageLink href={`mailto:${SECURITY_CONTACT_EMAIL}`}>
                  {SECURITY_CONTACT_EMAIL}
                </PageLink>
                .
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

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-3 pl-5 marker:text-subtle">{children}</ul>;
}

function PageLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="text-fg underline decoration-border underline-offset-4 transition-colors hover:decoration-fg"
    >
      {children}
    </a>
  );
}
