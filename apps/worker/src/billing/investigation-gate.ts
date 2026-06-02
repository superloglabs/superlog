// Investigation credit gate. Wraps Autumn's check/track so the worker can ask
// "may this org run another investigation?" before queueing one, and record a
// consumed credit when one completes. The org id IS the Autumn customer id
// (Better Auth's autumn plugin uses customerScope: "organization").
//
// Billing must never take investigations down: every call FAILS OPEN. If Autumn
// is unreachable or the org isn't provisioned yet, we allow the run and skip the
// charge rather than block a customer's incident response. Autumn itself also
// fail-opens on degraded downstream providers.
import { logger } from "../logger.js";

export const INVESTIGATION_FEATURE_ID = "investigations";

export type InvestigationGate = {
  // True if the org has at least one investigation credit (or overage) left.
  canRunInvestigation(orgId: string): Promise<boolean>;
  // Record one completed investigation against the org's credit balance.
  recordInvestigation(orgId: string): Promise<void>;
};

// Used in local dev / worktrees with no AUTUMN_SECRET_KEY: never gate.
const allowAllGate: InvestigationGate = {
  canRunInvestigation: async () => true,
  recordInvestigation: async () => {},
};

type FetchLike = typeof fetch;

export function createAutumnInvestigationGate(opts: {
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  // When false, usage is still tracked (recordInvestigation) but the gate never
  // blocks — i.e. metering-on, enforcement-off. Defaults to enforcing.
  enforce?: boolean;
}): InvestigationGate {
  const baseUrl = opts.baseUrl ?? "https://api.useautumn.com/v1";
  const doFetch = opts.fetchImpl ?? fetch;
  const enforce = opts.enforce !== false;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`autumn ${path} -> ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    canRunInvestigation: async (orgId) => {
      // Enforcement gated separately from metering: when off, never block (but
      // recordInvestigation below still tracks usage for billing + the UI meters).
      if (!enforce) return true;
      try {
        const r = await post("/check", {
          customer_id: orgId,
          feature_id: INVESTIGATION_FEATURE_ID,
        });
        // Only an explicit `false` blocks; anything else (incl. degraded 202s
        // or unexpected shapes) fails open.
        return r.allowed !== false;
      } catch (err) {
        logger.error(
          { scope: "billing.gate", orgId, err: err instanceof Error ? err.message : String(err) },
          "investigation credit check failed; allowing run (fail-open)",
        );
        return true;
      }
    },
    recordInvestigation: async (orgId) => {
      try {
        await post("/track", {
          customer_id: orgId,
          feature_id: INVESTIGATION_FEATURE_ID,
          value: 1,
        });
      } catch (err) {
        logger.error(
          { scope: "billing.gate", orgId, err: err instanceof Error ? err.message : String(err) },
          "investigation credit track failed; credit not recorded",
        );
      }
    },
  };
}

// Singleton used by the worker. Autumn-backed when AUTUMN_SECRET_KEY is set,
// otherwise a no-op allow-all gate so dev/worktrees aren't blocked.
export function createInvestigationGate(env: NodeJS.ProcessEnv = process.env): InvestigationGate {
  const secretKey = env.AUTUMN_SECRET_KEY?.trim();
  if (!secretKey) return allowAllGate;
  // Meter always (when keyed), but only BLOCK when enforcement is explicitly on.
  return createAutumnInvestigationGate({
    secretKey,
    enforce: env.BILLING_ENFORCEMENT_ENABLED === "true",
  });
}

export const investigationGate: InvestigationGate = createInvestigationGate();
