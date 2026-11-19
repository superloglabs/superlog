// Platform AI spend guard seam. Guards the per-org daily AI cost so a new
// tenant cannot silently run up unbounded Anthropic spend. The default is
// allow-all; deployments set AI_SPEND_GUARD_MODULE to override.
//
// Fail-open principle: every implementation must allow a run when spend data
// cannot be fetched so that an infrastructure hiccup never blocks incident
// response. The seam itself is synchronous; the proxy delegates to whatever
// guard is currently installed.

export type AiSpendGuard = {
  canStartAgentRun(orgId: string): Promise<boolean>;
};

const allowAllGuard: AiSpendGuard = {
  canStartAgentRun: async () => true,
};

let activeGuard: AiSpendGuard = allowAllGuard;

export function setAiSpendGuard(guard: AiSpendGuard): void {
  activeGuard = guard;
}

// Test/teardown helper: drop back to the no-op guard and allow re-init.
export function resetAiSpendGuard(): void {
  activeGuard = allowAllGuard;
  initialized = false;
}

// Proxy singleton: the worker checks spend through this object so a later
// setAiSpendGuard() call takes effect without re-importing the module.
export const aiSpendGuard: AiSpendGuard = {
  canStartAgentRun: (orgId) => activeGuard.canStartAgentRun(orgId),
};

let initialized = false;

// Resolve and install the configured guard. Called once at worker boot.
// Without AI_SPEND_GUARD_MODULE set the allow-all guard stays in place —
// that is the expected path for stock / self-hosted builds.
export async function initAiSpendGuard(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const specifier = process.env.AI_SPEND_GUARD_MODULE;
  if (!specifier) return;
  const mod = (await import(specifier)) as { aiSpendGuard?: unknown; default?: unknown };
  const guard = mod.aiSpendGuard ?? mod.default;
  if (!isAiSpendGuard(guard)) {
    throw new Error(
      "configured AI_SPEND_GUARD_MODULE must export an AiSpendGuard as aiSpendGuard or default",
    );
  }
  setAiSpendGuard(guard);
}

function isAiSpendGuard(value: unknown): value is AiSpendGuard {
  if (!value || typeof value !== "object") return false;
  const g = value as Partial<AiSpendGuard>;
  return typeof g.canStartAgentRun === "function";
}
