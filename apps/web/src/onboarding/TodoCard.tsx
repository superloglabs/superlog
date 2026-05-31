import { Btn } from "../design/ui.tsx";
import { ArrowIcon } from "./icons.tsx";
import type { Todo } from "./types.ts";

export function TodoCard({
  todo,
  onAction,
  busy,
}: {
  todo: Todo;
  onAction: () => void;
  busy?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-border bg-surface">
      <div className="px-7 pt-8 sm:px-9">
        <div className="mb-[18px] flex items-center gap-[14px]">
          <span className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-[rgba(72,90,226,0.35)] bg-[rgba(72,90,226,0.1)] text-[#8C98F0]">
            {todo.icon}
          </span>
          <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{todo.title}</h3>
        </div>
        <p className="m-0 max-w-[580px] text-[14px] leading-[1.55] text-muted">{todo.desc}</p>
      </div>
      <div className="flex items-center justify-end gap-2.5 px-7 pb-8 pt-6 sm:px-9">
        <Btn
          variant={todo.variant === "primary" ? "primary" : "secondary"}
          size="md"
          loading={busy}
          onClick={onAction}
          className={`!h-[36px] !rounded-[8px] !px-[14px] !text-[13px] ${todo.variant === "primary" ? "" : "!bg-white/[0.06]"}`}
        >
          {todo.cta}
          <ArrowIcon />
        </Btn>
      </div>
    </div>
  );
}
