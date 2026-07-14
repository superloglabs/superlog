import { useSyncExternalStore } from "react";

// Coordinates the org/project switcher with ProjectRouteBoundary during a
// cross-org switch.
//
// When the switcher flips Better Auth's active organization, `me` refetches to
// the new org while the URL still names the old org for a beat. ProjectRoute-
// Boundary treats the URL as the source of truth, so on that transient mismatch
// it would "reconcile" by calling setActiveContext for the *old* URL and
// reloading — reverting the switch. It can't tell that transient apart from a
// user pasting a stale URL (where the URL genuinely should win).
//
// The switcher owns the navigation for an in-flight switch, so while one is
// active the boundary must not reconcile. The switcher brackets its switch with
// begin/endOrgSwitch(); the boundary reads useIsSwitchingOrg() and skips its
// revert until the switch has navigated the URL to the new org.
//
// A counter (not a boolean) tolerates overlapping switches without one clearing
// another's lock.
let switching = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function beginOrgSwitch(): void {
  switching += 1;
  emit();
}

export function endOrgSwitch(): void {
  switching = Math.max(0, switching - 1);
  emit();
}

// Whether a cross-org switch is currently in flight. Exported for the hook
// below and for tests; components should use useIsSwitchingOrg().
export function isOrgSwitchingSnapshot(): boolean {
  return switching > 0;
}

export function useIsSwitchingOrg(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    isOrgSwitchingSnapshot,
    isOrgSwitchingSnapshot,
  );
}
