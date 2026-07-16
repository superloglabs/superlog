# Changelog

Notable changes to Superlog. Add new entries at the top. Each entry is a
`## YYYY-MM-DD — Title` heading; an optional `Tags:` line right under the
heading becomes the entry's labels.

## 2026-07-16 — Smarter custom MCP setup

Tags: Improvement, MCP

Adding a custom MCP server now detects standards-based OAuth automatically and
keeps manual credentials as an explicit fallback.

- Server names keep their original capitalization while Superlog generates a
  protocol-safe identifier behind the scenes.
- Authentication feedback is compact and manual options stay out of the way
  until you ask for them.

## 2026-07-09 — Incident page, redesigned

Tags: Improvement, Incidents

A rebuilt incident page centered on a single, unified activity feed — the
investigation, comments, and status changes all read as one timeline.

- When an investigation pauses to ask you something, the question shows up
  inline instead of getting buried.
- Query cards deep-link straight into Explore with "Open in Explore".
- Log and trace detail now open as a full-screen overlay with room to read.

## 2026-07-08 — Ask Superlog in Slack

Tags: Feature, Slack

@-mention the Superlog bot in any channel to ask about your code and telemetry
and get an answer in the thread. The bot also self-joins your notification
channel, so replies you post on an incident thread reach the investigation
agent.

## 2026-07-08 — Vercel, Railway, and Render connectors

Tags: Feature, Integrations

Connect Vercel, Railway, or Render in a couple of clicks and Superlog ingests
that platform's logs and metrics for you — no manual OTLP wiring. Joins the
existing AWS and Cloudflare connectors.

## 2026-07-08 — Snappier telemetry views

Tags: Improvement, Performance

- Telemetry pages show loading skeletons instead of blank flashes while data
  streams in.
- The metric-name picker reads from an hourly rollup, so it stays fast on
  high-volume projects.

## 2026-07-06 — Install MCP from settings

Tags: Feature, MCP

A new **Install MCP** tab in project settings walks you through connecting an
MCP client to Superlog, and the settings navigation is flattened so everything
is one click away.

## 2026-07-06 — Smarter issue lifecycle

Tags: Improvement

Issues now understand real silence and observation windows, and a recurrence
chains onto the original incident instead of alerting you from scratch every
time it comes back.

## 2026-07-03 — Faster Explore trace list

Tags: Improvement, Performance

The Explore trace list is served from derived rollup tables, so it loads
quickly even on projects pushing a high volume of spans.

## 2026-07-03 — Privacy policy

Tags: Improvement

Added a public privacy policy page, linked from the site footer.

## 2026-07-01 — Alert episodes

Tags: Feature, Alerts

Every contiguous firing of an alert is now grouped into a single **episode**, so
a flapping threshold reads as one event instead of a wall of duplicates.

- Alerts now open to a list of their past episodes.
- Incidents link back to the episode that triggered them.
- The alert editor shows a live preview chart with your threshold drawn on it.

## 2026-06-28 — Dashboard template variables

Tags: Feature, Dashboards

Grafana-style `$variable` template variables let one dashboard serve many
services or environments. Pick a value from the top of the dashboard and every
widget re-scopes to it — no more cloning a dashboard per service.

## 2026-06-24 — Faster exceptions and trace views

Tags: Improvement, Performance

Rebuilt how we store and query exceptions so error views and trace detail load
quickly even on high-volume projects. Loading spinners that used to hang on big
time ranges now resolve fast.

## 2026-06-18 — Investigation agent memory

Tags: Feature

The investigation agent now remembers what it learns about your codebase and
infrastructure across runs. Root-cause patterns, architecture facts, and
corrections carry forward, so each investigation starts smarter than the last.

## 2026-06-10 — Pin a favourite project

Tags: Improvement

Choose a default org and project that opens whenever you start a new session,
instead of landing on whatever you looked at last.

## 2026-06-02 — Configure investigations over MCP

Tags: Feature, MCP

Connected MCP clients can now read and edit a project's issue filter, project
context, and agent memories — the same knobs that shape how Superlog
investigates issues — without leaving your editor.
