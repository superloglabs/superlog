// Billing entitlement helpers shared by the app-wide "ingest paused" banner
// (App.tsx) and the billing settings card (BillingCard.tsx).
//
// The balance shape here is the subset of autumn-js's check() result we read.
// We keep it structural rather than importing autumn-js's types so this stays
// unit-testable without the billing SDK and doesn't break on SDK type churn.
export type EntitlementBalance =
  | {
      unlimited: boolean;
      granted: number;
      overageAllowed: boolean;
      usage: number;
    }
  | null
  | undefined;

export type EntitlementCheck = (args: { featureId: string }) => { balance: EntitlementBalance };

// True when a signal is at a *hard* cap: a bounded (granted > 0), non-overage
// feature whose usage has reached its allowance — the Free-tier state where
// ingest is paused. Metered/overage/unlimited signals never count.
//
// Crucially this NEVER throws. autumn-js's check() reads
// `customer.flags[featureId]` unguarded, so a brand-new org whose Autumn
// customer is truthy but not yet hydrated with `flags` makes check() throw
// "Cannot read properties of undefined (reading 'spans')". That used to bubble
// out of AuthenticatedApp's render and black-screen the whole app right after a
// user created their first org. We fail open here — an unreadable balance means
// "not capped", so a half-loaded customer shows the app instead of crashing it
// (real ingest/investigation enforcement lives server-side, not in this banner).
export function signalAtHardCap(check: EntitlementCheck, featureId: string): boolean {
  let balance: EntitlementBalance;
  try {
    balance = check({ featureId }).balance;
  } catch {
    return false;
  }
  return (
    !!balance &&
    !balance.unlimited &&
    balance.granted > 0 &&
    !balance.overageAllowed &&
    balance.usage >= balance.granted
  );
}
