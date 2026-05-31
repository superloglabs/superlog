import { useEffect, useRef, useState } from "react";
import { useSubmitFeedback } from "./api.ts";
import { Btn } from "./design/ui.tsx";

// In-product feedback dialog. Rendered as a "Give feedback" trigger button
// that opens a small modal with a textarea. On submit it POSTs to
// /api/feedback; the rest of the plumbing (admin inbox, Slack notify) is
// behind that endpoint.
//
// kind + refId together identify what the feedback is about. The caller
// (IssueDrawer / IncidentDrawerBody) passes its own ids. projectId is
// optional and only used by the API for orgId attribution in the inbox.
export function FeedbackTrigger({
  kind,
  refId,
  projectId,
  label = "Give feedback",
}: {
  kind: "incident" | "issue";
  refId: string;
  projectId?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-fg transition-colors hover:border-border-strong"
      >
        <span aria-hidden>💬</span>
        {label}
      </button>
      {open && (
        <FeedbackModal
          kind={kind}
          refId={refId}
          projectId={projectId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function FeedbackModal({
  kind,
  refId,
  projectId,
  onClose,
}: {
  kind: "incident" | "issue";
  refId: string;
  projectId?: string;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(false);
  const submit = useSubmitFeedback();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Stop sub-second double-clicks from posting twice. The dialog uses an
  // ephemeral "sent" state rather than a router redirect because the modal
  // lives on top of a drawer — we want the user to read the confirmation
  // in-place, then close back to the drawer they came from.
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submit.isPending || sent) return;
    const text = body.trim();
    if (!text) return;
    submit.mutate(
      { kind, refId, body: text, projectId },
      {
        onSuccess: () => setSent(true),
      },
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md border border-border bg-bg p-5 shadow-2xl">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[14px] font-medium tracking-tight">Send feedback</h3>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">
            {kind}
          </span>
        </div>
        {sent ? (
          <div className="space-y-4">
            <p className="text-[13px] text-muted">Thanks — the Superlog team will see this.</p>
            <div className="flex justify-end">
              <Btn variant="secondary" onClick={onClose}>
                Close
              </Btn>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-[12px] text-muted">
              What worked, what didn't, what's missing. This goes straight to the Superlog team.
            </p>
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              maxLength={8000}
              required
              placeholder="Type your feedback…"
              className="block w-full rounded-sm border border-border bg-surface-2 px-3 py-2 text-[13px] text-fg outline-none placeholder:text-subtle focus:border-border-strong"
            />
            {submit.error && (
              <p className="font-mono text-[11px] text-danger">{(submit.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={onClose}>
                Cancel
              </Btn>
              <Btn type="submit" loading={submit.isPending} disabled={!body.trim()}>
                Send
              </Btn>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
