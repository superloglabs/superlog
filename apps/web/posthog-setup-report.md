<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Superlog web app. Here's what was done:

- **PostHogProvider** added to `src/main.tsx`, wrapping the entire app so all components have access to the PostHog client. Calls are proxied through Vite's dev server via `/ingest` to avoid ad-blocker interference.
- **User identification** added to `src/App.tsx` via a `PostHogUserSync` component that uses Clerk's `useUser` hook to call `posthog.identify()` with the Clerk user ID, email, and name on sign-in, and `posthog.reset()` on sign-out.
- **Vite proxy** configured in `vite.config.ts` to route `/ingest`, `/ingest/static`, and `/ingest/array` to the EU PostHog host, avoiding ad-blocker interference.
- **Environment variables** written to `apps/web/.env`: `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN` and `VITE_PUBLIC_POSTHOG_HOST`.
- **15 events** instrumented across 5 files covering the full user journey from landing page to active usage.

> **Action required:** Run `pnpm install` from the monorepo root to install the `posthog-js` dependency that was added to `package.json`.

## Events instrumented

| Event | Description | File |
|---|---|---|
| `sign_in_clicked` | User clicks 'Sign in' on the landing page | `src/Landing.tsx` |
| `sign_up_clicked` | User clicks 'Get started' on the landing page | `src/Landing.tsx` |
| `cli_command_copied` | User copies the npx CLI install command | `src/Landing.tsx` |
| `cli_session_approved` | User successfully approves a CLI session | `src/Activate.tsx` |
| `github_connected_from_activate` | User clicks 'Connect GitHub' during CLI activation | `src/Activate.tsx` |
| `api_key_created` | User creates a new API key | `src/Dashboard.tsx` |
| `api_key_revoked` | User revokes an existing API key | `src/Dashboard.tsx` |
| `github_connected` | User initiates GitHub connection from dashboard | `src/Dashboard.tsx` |
| `slack_connected` | User initiates Slack connection from dashboard | `src/Dashboard.tsx` |
| `slack_alert_channel_set` | User saves a Slack alert channel | `src/Dashboard.tsx` |
| `slack_alert_channel_removed` | User removes the configured Slack alert channel | `src/Dashboard.tsx` |
| `issue_resolved` | User resolves an open issue | `src/Issues.tsx` |
| `issue_reopened` | User reopens a resolved issue | `src/Issues.tsx` |
| `mcp_oauth_authorized` | User authorizes an MCP client via OAuth | `src/OauthConsent.tsx` |
| `mcp_oauth_denied` | User denies an MCP client authorization | `src/OauthConsent.tsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard**: [Analytics basics](https://eu.posthog.com/project/165983/dashboard/642423)
- **Insight**: [Sign-up & Sign-in Funnel](https://eu.posthog.com/project/165983/insights/olx7R8Gm) — conversion from sign-up click to CLI session approved
- **Insight**: [CLI Command Copies (Trend)](https://eu.posthog.com/project/165983/insights/zYZFVIrU) — daily trend of landing page CLI copies
- **Insight**: [Integration Connections (GitHub & Slack)](https://eu.posthog.com/project/165983/insights/z12kBppi) — integration adoption over time
- **Insight**: [Issue Resolution Rate](https://eu.posthog.com/project/165983/insights/VSPa2tuf) — issues resolved vs reopened
- **Insight**: [API Keys Created & Revoked](https://eu.posthog.com/project/165983/insights/gUSwZCCC) — key lifecycle (high revocation = potential churn signal)

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-react-tanstack-router-file-based/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
