<a href="https://superlog.sh">
  <img width="1200" height="675" alt="github" src="https://github.com/user-attachments/assets/b04b83a7-7c0f-481d-8bdd-ced1d3ca5fd2" />

</a>
&nbsp;
<p align="center">
  badge1
  &nbsp;
  badge2
</p>

<p align="center">
  <a href="https://superlog.sh">Website</a>
  ·
  <a href="https://github.com/superloglabs/superlog">Code</a>
  ·
  <a href="https://github.com/superloglabs/skills">Skills</a>
  ·
  <a href="https://github.com/superloglabs/otel-helpers">Helpers</a>
  ·
  <a href="https://discord.gg/bqJYtW3n">Discord</a>
</p>

## About

[Superlog](https://superlog.sh) is an open-source agentic telemetry system. It
ingests traces, logs, and metrics, groups noisy signals into incidents, and watches your infra while you sleep.

## Installation

You can install Superlog in your project by using our [skills](https://superlog.sh) in your favourite coding agent:

```
Run npx skills add superloglabs/skills --all and use the skills to install Superlog in this project
```



## What is Superlog?

Superlog is an open-core observability workspace for OpenTelemetry data. It
ingests traces, logs, and metrics, groups noisy signals into incidents, and gives
teams a local-first product surface for debugging production systems.

This repository contains the fully open-source, free community edition:

- Web app and API
- OTLP ingest proxy
- Worker processes for incident grouping and background jobs
- Postgres schema and ClickHouse-backed telemetry queries
- Agent runner interfaces for pluggable investigation runtimes
- A default `community` agent runner that records a local incident summary

We also provide a hosted Superlog Cloud edition with a free tier, a pay-to-go plan and monthly credit packs.

## Quick Start

Prerequisites:

- Node.js 20+
- pnpm 9+
- Docker

Install dependencies:

```bash
pnpm install
```

Start the local stack:

```bash
docker compose up -d
pnpm --filter @superlog/db db:migrate
pnpm dev
```

The default local services are:

- Web: `http://localhost:5173`
- API: `http://localhost:4100`
- OTLP intake: `http://localhost:4101`

## Development

Run typechecks:

```bash
pnpm typecheck
```

## Repository Layout

- `apps/web` - Vite/React frontend
- `apps/api` - HTTP API
- `apps/proxy` - OTLP intake proxy
- `apps/worker` - background workers and agent orchestration
- `packages/db` - Drizzle schema and migrations
- `packages/fingerprint` - telemetry fingerprinting helpers

## License

License selection is pending before the public launch.
