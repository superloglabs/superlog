import { useEffect, useState } from "react";
import { Btn } from "../design/ui.tsx";
import { TodoCard } from "./TodoCard.tsx";
import { ArrowIcon, ArrowLeftIcon, CheckIcon } from "./icons.tsx";
import type { Todo, TodoId } from "./types.ts";

export function TodoCarousel({
  todos,
  busyId,
  total,
  completed,
  onAction,
}: {
  todos: Todo[];
  busyId?: TodoId | null;
  total: number;
  completed: number;
  onAction: (todo: Todo) => void;
}) {
  const [idx, setIdx] = useState(0);
  const visible = todos;
  const safeIdx = Math.min(idx, Math.max(0, visible.length - 1));
  const current = visible[safeIdx];

  useEffect(() => {
    if (idx > visible.length - 1) setIdx(Math.max(0, visible.length - 1));
  }, [visible.length, idx]);

  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  if (!current) {
    return (
      <div className="rounded-[14px] border border-border bg-surface px-8 py-10 text-center">
        <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-success/15 text-success">
          <CheckIcon size={20} />
        </div>
        <div className="text-[17px] font-semibold text-fg">You're all set</div>
      </div>
    );
  }

  return (
    <section>
      <div className="mb-4 flex items-end justify-between">
        <h2 className="m-0 text-[22px] font-semibold tracking-[-0.02em] text-fg">
          Finish setting up Superlog
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-subtle">
            {completed} / {total}
          </span>
          <div className="h-1 w-[120px] overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="relative">
        <div className="overflow-hidden rounded-[14px]">
          <div
            className="flex transition-transform duration-[320ms]"
            style={{
              transform: `translateX(-${safeIdx * 100}%)`,
              transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            {visible.map((t) => (
              <div key={t.id} className="w-full flex-none px-px">
                <TodoCard todo={t} onAction={() => onAction(t)} busy={busyId === t.id} />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-[18px] flex items-center justify-end">
          <div className="flex gap-1.5">
            <Btn
              variant="secondary"
              size="sm"
              disabled={safeIdx === 0}
              onClick={() => setIdx(Math.max(0, safeIdx - 1))}
              className="!h-[30px] !rounded-[8px] !bg-white/[0.06] !px-[10px]"
            >
              <ArrowLeftIcon />
              Prev
            </Btn>
            <Btn
              variant="secondary"
              size="sm"
              disabled={safeIdx === visible.length - 1}
              onClick={() => setIdx(Math.min(visible.length - 1, safeIdx + 1))}
              className="!h-[30px] !rounded-[8px] !bg-white/[0.06] !px-[10px]"
            >
              Next
              <ArrowIcon />
            </Btn>
          </div>
        </div>
      </div>
    </section>
  );
}
