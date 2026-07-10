import type { ResolvedIntegration } from "../integrations.js";

const MOBILE_FILE_PREFIXES = ["app/", "ios/", "android/", "components/", "screens/"];

// Whether a change reads as a mobile-app change — by service name or by the
// files it touches — and therefore falls under the Revyl regression-test gate.
export function looksLikeMobileChange(opts: {
  service: string | null;
  changedFiles: string[] | undefined;
}): boolean {
  if (/mobile/i.test(opts.service ?? "")) return true;
  return (opts.changedFiles ?? []).some((file) =>
    MOBILE_FILE_PREFIXES.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix)),
  );
}

// Whether the org's Revyl integration exposes the create-test operation the
// mobile regression-test gate depends on.
export function hasRevylCreateTestIntegration(integrations: ResolvedIntegration[]): boolean {
  return integrations.some(
    (integration) =>
      integration.definition.slug === "revyl" &&
      integration.definition.operations.some((op) => op.name === "revyl_create_test_from_yaml"),
  );
}
