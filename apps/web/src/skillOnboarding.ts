export const SKILL_ONBOARDING_FLAG_KEY = "superlog:skill-onboarding";
export const SKILL_ONBOARDING_KEY_CACHE = "superlog:skill-onboarding-key";
export const SKILL_ONBOARDING_INTENT_KEY = "superlog:skill-onboarding-intent";

export function isSkillOnboardingPending(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(SKILL_ONBOARDING_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function getSkillOnboardingIntent(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(SKILL_ONBOARDING_INTENT_KEY);
  } catch {
    return null;
  }
}

export function startSkillOnboarding(intentId?: string | null) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SKILL_ONBOARDING_FLAG_KEY, "1");
    if (intentId) sessionStorage.setItem(SKILL_ONBOARDING_INTENT_KEY, intentId);
  } catch {
    /* ignore */
  }
}

export function finishSkillOnboarding() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(SKILL_ONBOARDING_FLAG_KEY);
    sessionStorage.removeItem(SKILL_ONBOARDING_KEY_CACHE);
    sessionStorage.removeItem(SKILL_ONBOARDING_INTENT_KEY);
  } catch {
    /* ignore */
  }
}
