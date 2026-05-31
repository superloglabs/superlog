# Superlog

Superlog is an open-core observability workspace for OpenTelemetry data. It
ingests traces, logs, and metrics, groups noisy signals into incidents, and gives
teams a local-first product surface for debugging production systems.

This repository contains the community edition:

- Web app and API
- OTLP ingest proxy
- Worker processes for incident grouping and background jobs
- Postgres schema and ClickHouse-backed telemetry queries
- Agent runner interfaces for pluggable investigation runtimes
- A default `community` agent runner that records a local incident summary

Managed cloud infrastructure and Superlog's hosted agent runtime are maintained
outside this repository.

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
