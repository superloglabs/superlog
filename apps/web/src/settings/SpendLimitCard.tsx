import { useCustomer } from "autumn-js/react";
import { useEffect, useState } from "react";
import { type SpendLimit, useRemoveSpendLimit, useSetSpendLimit, useSpendLimit } from "../api.ts";
import { Btn, Input } from "../design/ui.tsx";

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatResetDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp),
  );
}

export function SpendLimitCard() {
  const spendLimit = useSpendLimit();
  const setLimit = useSetSpendLimit();
  const removeLimit = useRemoveSpendLimit();
  const { refetch } = useCustomer();
  const [error, setError] = useState<string | null>(null);

  if (!spendLimit.data?.available) return null;

  const run = async (change: () => Promise<unknown>) => {
    setError(null);
    try {
      await change();
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t update the limit — please try again.");
    }
  };

  return (
    <SpendLimitPanel
      limit={spendLimit.data}
      busy={setLimit.isPending || removeLimit.isPending}
      error={error}
      onSave={(limitUsd) => run(() => setLimit.mutateAsync(limitUsd))}
      onRemove={() => run(() => removeLimit.mutateAsync())}
    />
  );
}

export function SpendLimitPanel({
  limit,
  busy,
  error,
  onSave,
  onRemove,
}: {
  limit: SpendLimit;
  busy: boolean;
  error: string | null;
  onSave: (limitUsd: number) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(limit.limitUsd?.toString() ?? "");
  useEffect(() => setDraft(limit.limitUsd?.toString() ?? ""), [limit.limitUsd]);

  const amount = Number(draft);
  const minimum = limit.minimumUsd ?? 1;
  const valid = draft.trim() !== "" && Number.isFinite(amount) && amount >= minimum;
  const unchanged = amount === limit.limitUsd;
  const reached = limit.status === "reached";
  const resets = limit.resetsAt ? formatResetDate(limit.resetsAt) : "your next billing cycle";

  return (
    <div className="rounded-lg border border-border bg-surface/30 p-4">
      <div className="text-[13px] font-medium text-fg">Monthly spend limit</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        When your estimated bill reaches this amount, Superlog stops anything billable until{" "}
        {resets}: telemetry beyond your included allowance is dropped and billable investigations
        are paused. You can raise or remove the limit at any time to resume.
      </p>

      {limit.limitUsd !== null && limit.billUsd !== null && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12.5px] tabular-nums text-fg">
              {formatUsd(limit.billUsd)} of {formatUsd(limit.limitUsd)}
            </span>
            <span className="text-[12.5px] font-medium tabular-nums text-muted">
              {Math.min(limit.pct ?? 0, 100)}%
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
            <div
              className={`h-full rounded-full ${reached ? "bg-danger" : "bg-accent"}`}
              style={{ width: `${Math.min(limit.pct ?? 0, 100)}%` }}
            />
          </div>
          {reached && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-danger">
              Limit reached. Billable usage is paused until {resets}.
            </p>
          )}
        </div>
      )}

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !unchanged) onSave(amount);
        }}
      >
        <span className="text-[13px] text-muted">$</span>
        <Input
          aria-label="Monthly spend limit in US dollars"
          inputMode="decimal"
          placeholder={String(Math.max(minimum, 100))}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Btn type="submit" variant="primary" size="sm" disabled={busy || !valid || unchanged}>
          {busy ? "Saving…" : limit.limitUsd === null ? "Set limit" : "Update"}
        </Btn>
        {limit.limitUsd !== null && (
          <Btn type="button" variant="secondary" size="sm" disabled={busy} onClick={onRemove}>
            Remove
          </Btn>
        )}
      </form>

      {minimum > 1 && (
        <p className="mt-2 text-[11.5px] text-subtle">
          The limit must be at least {formatUsd(minimum)}, above your plan’s monthly fee.
        </p>
      )}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
