import { useState } from "react";
import { useParams } from "react-router-dom";
import { submitPrFeedback } from "./api.ts";
import { Btn, CenteredShell, Wordmark } from "./design/ui.tsx";

// Public page reached from the "Leave feedback" link the worker appends
// to every agent-opened PR description. Renders without an auth gate so
// external PR participants (customer collaborators, contributors who
// don't have a Superlog account) can submit. The API route
// /feedback/pr/:owner/:repo/:number is open to anonymous POSTs for the
// same reason; if the user happens to have a session cookie set we
// attribute the feedback to them on the server, otherwise we record
// the GitHub login they typed in (or "anonymous").
export function PrFeedback() {
  const { owner, repo, number } = useParams<{ owner: string; repo: string; number: string }>();
  const prNumber = Number(number);
  const [body, setBody] = useState("");
  const [githubLogin, setGithubLogin] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!owner || !repo || !Number.isFinite(prNumber) || prNumber <= 0) {
    return (
      <CenteredShell>
        <div className="space-y-2 text-center">
          <Wordmark />
          <p className="text-[13px] text-muted">Invalid feedback link.</p>
        </div>
      </CenteredShell>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text || pending) return;
    setPending(true);
    setError(null);
    try {
      await submitPrFeedback({
        owner: owner as string,
        repo: repo as string,
        prNumber,
        body: text,
        githubLogin: githubLogin.trim() || undefined,
      });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <CenteredShell>
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2">
          <Wordmark />
          <h1 className="text-[16px] font-medium tracking-tight">Feedback on PR #{prNumber}</h1>
          <p className="font-mono text-[11px] text-subtle">
            {owner}/{repo}
          </p>
        </div>

        {sent ? (
          <div className="space-y-3 border border-border bg-surface-2 p-4">
            <p className="text-[13px] text-fg">Thanks — the Superlog team will see this.</p>
            <p className="text-[12px] text-muted">
              You can close this tab. We don't follow up by email; if you want a reply, leave your
              contact in the message and we'll respond on the PR.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-[13px] text-muted">
              Was this PR helpful? Confusing? Did something break? Goes straight to the Superlog
              team.
            </p>
            <div className="space-y-1">
              <label
                htmlFor="feedback-body"
                className="block font-mono text-[10px] uppercase tracking-[0.2em] text-subtle"
              >
                Your feedback
              </label>
              <textarea
                id="feedback-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                maxLength={8000}
                required
                placeholder="What worked, what didn't, what's missing…"
                className="block w-full rounded-sm border border-border bg-surface-2 px-3 py-2 text-[13px] text-fg outline-none placeholder:text-subtle focus:border-border-strong"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="feedback-github"
                className="block font-mono text-[10px] uppercase tracking-[0.2em] text-subtle"
              >
                GitHub handle (optional)
              </label>
              <input
                id="feedback-github"
                type="text"
                value={githubLogin}
                onChange={(e) => setGithubLogin(e.target.value)}
                maxLength={64}
                placeholder="octocat"
                className="block w-full rounded-sm border border-border bg-surface-2 px-3 py-2 text-[13px] text-fg outline-none placeholder:text-subtle focus:border-border-strong"
              />
              <p className="font-mono text-[10px] text-subtle">
                So we know who to follow up with on the PR.
              </p>
            </div>
            {error && <p className="font-mono text-[11px] text-danger">{error}</p>}
            <div className="flex justify-end">
              <Btn type="submit" loading={pending} disabled={!body.trim()}>
                Send feedback
              </Btn>
            </div>
          </form>
        )}
      </div>
    </CenteredShell>
  );
}
