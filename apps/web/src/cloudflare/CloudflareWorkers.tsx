import { useState } from "react";
import {
  useCloudflareWorkers,
  useSetCloudflareAutoWire,
  useUnwireAllCloudflareWorkers,
  useUnwireCloudflareWorker,
  useWireAllCloudflareWorkers,
  useWireCloudflareWorker,
} from "../api.ts";
import { Btn, Chip } from "../design/ui.tsx";
import { Toggle } from "../settings/Toggle.tsx";

// The account's Workers, each with its current wiring state. New connections
// start with none selected; the user can choose individual Workers, apply a
// one-shot bulk action, or explicitly opt into durable account-wide auto-wire.
export function CloudflareWorkers({
  projectId,
  accountId,
  autoWire,
}: {
  projectId: string | undefined;
  accountId: string;
  autoWire: boolean;
}) {
  const workers = useCloudflareWorkers(projectId, accountId, true);
  const wire = useWireCloudflareWorker(projectId);
  const unwire = useUnwireCloudflareWorker(projectId);
  const wireAll = useWireAllCloudflareWorkers(projectId);
  const unwireAll = useUnwireAllCloudflareWorkers(projectId);
  const setAutoWire = useSetCloudflareAutoWire(projectId);
  const [busy, setBusy] = useState<string | null>(null);

  const list = workers.data?.workers ?? [];
  const anyWired = list.some((worker) => worker.hasWiring);
  const anyUnwired = list.some((worker) => !worker.wired);
  // Disable every wiring control during a change so overlapping Cloudflare
  // settings PATCHes cannot race to a nondeterministic final state.
  const anyWiringPending =
    wire.isPending ||
    unwire.isPending ||
    wireAll.isPending ||
    unwireAll.isPending ||
    setAutoWire.isPending;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Auto-wire all Workers</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
            Keep every Worker connected automatically, including new or recreated ones. Leave off to
            choose Workers manually.
          </p>
        </div>
        <Toggle
          ariaLabel="Auto-wire all Cloudflare Workers"
          checked={autoWire}
          disabled={anyWiringPending}
          onChange={(value) => setAutoWire.mutate(value)}
        />
      </div>

      {workers.isLoading ? (
        <p className="text-[13px] text-muted">Loading workers…</p>
      ) : workers.isError ? (
        <p className="text-[13px] text-danger">
          Couldn't load workers — the Cloudflare connection may need reconnecting.
        </p>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted">No Workers found in this account.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium">Choose Workers to stream</span>
            <div className="flex items-center gap-2">
              <Btn
                size="sm"
                variant="secondary"
                loading={unwireAll.isPending}
                disabled={!anyWired || anyWiringPending}
                onClick={() => unwireAll.mutate()}
              >
                Unwire all
              </Btn>
              <Btn
                size="sm"
                variant="secondary"
                loading={wireAll.isPending}
                disabled={!anyUnwired || anyWiringPending}
                onClick={() => wireAll.mutate()}
              >
                Wire all
              </Btn>
            </div>
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {list.map((worker) => {
              const pending = busy === worker.name && (wire.isPending || unwire.isPending);
              return (
                <li key={worker.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-[13px]">{worker.name}</span>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <Chip
                      tone={worker.wired ? "success" : worker.hasWiring ? "warning" : "muted"}
                      dot
                    >
                      {worker.wired
                        ? "Streaming"
                        : worker.hasWiring
                          ? "Partially wired"
                          : "Not wired"}
                    </Chip>
                    {!autoWire && (
                      <Btn
                        size="sm"
                        variant={worker.hasWiring ? "secondary" : "primary"}
                        loading={pending}
                        disabled={anyWiringPending}
                        onClick={() => {
                          setBusy(worker.name);
                          (worker.hasWiring ? unwire : wire).mutate(worker.name, {
                            onSettled: () => setBusy(null),
                          });
                        }}
                      >
                        {worker.hasWiring ? "Unwire" : "Wire"}
                      </Btn>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
