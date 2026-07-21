import { Tile } from "../design/ui.tsx";
import { Toggle } from "./Toggle.tsx";

export function InactiveIncidentResolutionCard({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <Tile>
      <section
        aria-labelledby="inactive-incident-resolution-title"
        className="flex items-start justify-between gap-6"
      >
        <div className="min-w-0">
          <h2 id="inactive-incident-resolution-title" className="text-[14px] font-semibold text-fg">
            Auto-resolve inactive incidents
          </h2>
          <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
            Once a day, resolve open incidents when none of their linked errors have appeared for 14
            days. Superlog posts the automatic resolution in the incident&apos;s Slack thread.
          </p>
        </div>
        <Toggle
          ariaLabel="Auto-resolve inactive incidents"
          checked={enabled}
          disabled={disabled}
          onChange={onChange}
        />
      </section>
    </Tile>
  );
}
