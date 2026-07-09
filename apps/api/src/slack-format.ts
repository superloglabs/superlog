// Slack mrkdwn escaping helpers, shared across the api app's Slack surfaces
// (feedback follow-up offers, resolved-incident root message, …). The worker
// keeps its own copy in infra/slack/incident-messages.ts because the two apps
// don't share a build target — keep the rules here and there in sync.

// Escape the label side of a `<url|label>` link. Slack requires &, <, > escaped
// inside link text; otherwise a title like `a > b` truncates the span. Plain
// `*text*` (no link) renders these literally and doesn't need this.
export function escapeSlackLinkText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Escape the URL side of a `<url|label>` link. In Slack mrkdwn `|` separates the
// URL from the label and `>` closes the link, so a URL containing either would
// truncate the link or inject formatting. Both are percent-encodable, so encode
// them rather than dropping them.
export function escapeSlackLinkUrl(url: string): string {
  return url.replace(/\|/g, "%7C").replace(/>/g, "%3E");
}
