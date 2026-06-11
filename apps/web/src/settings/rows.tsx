import type { ReactNode } from "react";

// Row-style settings primitives: a bordered card stacking rows separated by
// hairline dividers. Each row puts a title + short description on the left
// and a compact control (input, dropdown, toggle, button) on the right;
// full-width content (textareas, lists) can sit underneath via children.

export function SettingsCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`divide-y divide-border rounded-lg border border-border bg-surface ${className}`}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  control,
  children,
}: {
  title: ReactNode;
  // Secondary line under the title; keep it to one short sentence.
  description?: ReactNode;
  // Compact widget rendered on the right edge of the row.
  control?: ReactNode;
  // Optional full-width content below the title/control lane.
  children?: ReactNode;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-fg">{title}</p>
          {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

// Right-aligned action lane (save / discard / status) at the bottom of a card.
export function SettingsCardFooter({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-2 px-5 py-3">{children}</div>;
}
