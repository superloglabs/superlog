# Changelog

Notable changes to Superlog. Add new entries at the top. Each entry is a
`## YYYY-MM-DD — Title` heading; an optional `Tags:` line right under the
heading becomes the entry's labels.

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
