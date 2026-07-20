import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Centered modal that hosts a single integration's configuration. Opened by
 * clicking a card in the integrations bento; dismissed via the scrim, the
 * header X, or Escape. Same overlay chrome as the MCP install dialog.
 */
export function IntegrationConfigDialog({
  title,
  subtitle,
  glyph,
  status,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  glyph?: ReactNode;
  status?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Keep Tab cycling inside the panel while the dialog is open.
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusables.at(0);
      const last = focusables.at(-1);
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && panel.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus into the dialog on mount; restore it to the trigger on close.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      // biome-ignore lint/a11y/useSemanticElements: <dialog> would require .showModal() lifecycle wiring; conditional render with role="dialog" is intentional.
      role="dialog"
      aria-modal="true"
      aria-labelledby="integration-config-dialog-title"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default border-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex max-h-[80vh] w-full max-w-[640px] flex-col overflow-hidden rounded-[14px] border border-border-strong bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.5)] focus:outline-none"
      >
        <div className="flex items-start gap-3 border-b border-border px-[22px] py-[18px]">
          {glyph}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h2
                id="integration-config-dialog-title"
                className="text-[17px] font-semibold tracking-[-0.01em] text-fg"
              >
                {title}
              </h2>
              {status}
            </div>
            <p className="mt-0.5 text-[12px] text-subtle">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 grid h-7 w-7 place-items-center text-muted transition-colors hover:text-fg"
            aria-label="Close"
          >
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m3 3 6 6m0-6-6 6" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
