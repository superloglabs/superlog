import type { ReactNode } from "react";
import { Wordmark } from "./design/ui.tsx";

const COMMON_PAPER_CSA_URL = "https://commonpaper.com/standards/cloud-service-agreement/2.1/";
const PRICING_URL = "https://superlog.sh/pricing";

export function TermsOfService() {
  return (
    <div className="min-h-screen bg-bg font-sans text-fg">
      <header className="sticky top-0 z-40 border-b border-border bg-bg">
        <div className="mx-auto flex w-full max-w-[980px] items-center justify-between px-4 py-5 md:px-8">
          <a href="/" aria-label="Superlog home">
            <Wordmark />
          </a>
          <a
            href="/pricing"
            className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
          >
            Pricing
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[980px] px-4 py-14 md:px-8 md:py-20">
        <article className="max-w-[780px]">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle">
            Last Updated: June 2, 2026
          </p>
          <h1
            className="mt-5 text-[2.25rem] leading-tight tracking-tight text-fg md:text-[3.75rem]"
            style={{ fontWeight: 450 }}
          >
            Pulsent Labs Inc. Terms of Service
          </h1>

          <div className="mt-12 space-y-10 text-[15px] leading-7 text-muted md:text-[16px]">
            <Section>
              <p>
                If you signed a separate Cover Page to access the Product with the same account, and
                that agreement has not ended, the terms below do not apply to you. Instead, your
                separate Cover Page applies to your use of the Product.
              </p>
              <p>
                This Agreement is between Pulsent Labs Inc. and the company or person accessing or
                using the Product. This Agreement consists of: (1) the Order Form below and (2) the
                Framework Terms defined below.
              </p>
              <p>
                If you are accessing or using the Product on behalf of your company, you represent
                that you are authorized to accept this Agreement on behalf of your company. By
                signing up, accessing, or using the Product, Customer indicates its acceptance of
                this Agreement and agrees to be bound by the terms and conditions of this Agreement.
              </p>
            </Section>

            <Section title="Cover Page">
              <h3 className="text-[18px] font-semibold text-fg">Order Form</h3>
              <TermRow label="Framework Terms">
                This Order Form incorporates and is governed by the Framework Terms that are made up
                of the Key Terms below and the{" "}
                <ExternalLink href={COMMON_PAPER_CSA_URL}>
                  Common Paper Cloud Service Agreement Standard Terms Version 2.1
                </ExternalLink>
                , which are incorporated by reference. Any modifications to the Standard Terms made
                in the Cover Page will control over conflicts with the Standard Terms. Capitalized
                words have the meanings given in the Cover Page or the Standard Terms.
              </TermRow>
              <TermRow label="Cloud Service">
                Superlog, an AI-native observability platform that monitors your applications and
                autonomously investigates and fixes bugs.
              </TermRow>
              <TermRow label="Order Date">The Effective Date</TermRow>
              <TermRow label="Subscription Period">1 month(s)</TermRow>
              <TermRow label="Cloud Service Fees">
                Certain parts of the Product have different pricing plans, which are available at
                Provider's <ExternalLink href={PRICING_URL}>pricing page</ExternalLink>. Customer
                will pay Provider the applicable Fees based on the Product tier and Customer's
                usage. Provider may update Product pricing by giving at least 30 days notice to
                Customer (including by email or notification within the Product), and the change
                will apply in the next Subscription Period.
              </TermRow>
              <TermRow label="Payment Process">
                Automatic payment: Customer authorizes Provider to bill and charge Customer's
                payment method on file Monthly for immediate payment or deduction without further
                approval.
              </TermRow>
              <TermRow label="Non-Renewal Notice Period">
                At least 30 days before the end of the current Subscription Period.
              </TermRow>
            </Section>

            <Section title="Key Terms">
              <TermRow label="Customer">
                The company or person who accesses or uses the Product. If the person accepting this
                Agreement is doing so on behalf of a company, all use of the word "Customer" in the
                Agreement will mean that company.
              </TermRow>
              <TermRow label="Provider">Pulsent Labs Inc.</TermRow>
              <TermRow label="Effective Date">
                The date Customer first accepts this Agreement.
              </TermRow>
              <TermRow label="Governing Law">The laws of the State of Delaware</TermRow>
              <TermRow label="Chosen Courts">
                The state or federal courts located in Delaware
              </TermRow>
              <TermRow label="Covered Claims">
                <div className="space-y-4">
                  <p>
                    <span className="font-semibold text-fg">Provider Covered Claims:</span> Any
                    action, proceeding, or claim that the Cloud Service, when used by Customer
                    according to the terms of the Agreement, violates, misappropriates, or otherwise
                    infringes upon anyone else's intellectual property or other proprietary rights.
                  </p>
                  <p>
                    <span className="font-semibold text-fg">Customer Covered Claims:</span> Any
                    action, proceeding, or claim that (1) the Customer Content, when used according
                    to the terms of the Agreement, violates, misappropriates, or otherwise infringes
                    upon anyone else's intellectual property or other proprietary rights; or (2)
                    results from Customer's breach or alleged breach of Section 2.1 (Restrictions on
                    Customer).
                  </p>
                </div>
              </TermRow>
              <TermRow label="General Cap Amount">
                The fees paid or payable by Customer to provider in the 12 month period immediately
                before the claim
              </TermRow>
              <TermRow label="Notice Address">
                <div className="space-y-2">
                  <p>For Provider: nicolo@superlog.sh</p>
                  <p>For Customer: The main email address on Customer's account</p>
                </div>
              </TermRow>
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

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-fg underline decoration-border underline-offset-4 transition-colors hover:decoration-fg"
    >
      {children}
    </a>
  );
}
