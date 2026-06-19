import { Btn } from "../design/ui.tsx";
import { ArrowIcon } from "./icons.tsx";

// Persistent, always-on nudge shown over the app while the user is exploring
// demo (sample) data. It is deliberately prominent and NOT dismissable — the
// whole point of demo mode is to keep pushing the user toward instrumenting
// their own app. Clicking "Connect your app" drops the demo-exploring opt-in,
// which sends them back to the install wizard. It disappears on its own the
// moment real telemetry lands (the gate stops rendering it).
export function InstallNudge({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 w-[320px] overflow-hidden rounded-[14px] border border-[rgba(140,152,240,0.35)] bg-[#0f1014] shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
      <div className="flex items-start gap-2.5 border-b border-[rgba(255,255,255,0.07)] px-[18px] py-[14px]">
        <span className="mt-1 h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-[#8C98F0]" />
        <div className="flex-1">
          <p className="m-0 text-[13.5px] font-semibold text-fg">You're exploring sample data</p>
          <p className="m-0 mt-1 text-[12.5px] leading-[1.5] text-muted">
            These incidents, dashboards and traces are a demo. Connect your own app to see your real
            data here — it takes a couple of minutes.
          </p>
        </div>
      </div>
      <div className="px-[18px] py-[12px]">
        <Btn
          variant="primary"
          size="md"
          onClick={onConnect}
          className="!h-[36px] w-full !justify-center !rounded-[8px] !px-[14px] !text-[13px]"
        >
          Connect your app
          <ArrowIcon />
        </Btn>
      </div>
    </div>
  );
}
