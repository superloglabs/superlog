# Build context: repo root. Build with `docker build -f apps/proxy/Dockerfile .`
FROM node:20-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/proxy/package.json apps/proxy/
COPY packages/db/package.json packages/db/
COPY packages/fingerprint/package.json packages/fingerprint/

RUN pnpm install --frozen-lockfile --filter @superlog/proxy...

COPY tsconfig.base.json ./
COPY apps/proxy apps/proxy
COPY packages/db packages/db
COPY packages/fingerprint packages/fingerprint

ENV PORT=4000
EXPOSE 4000

# Run node directly with the tsx loader rather than via `pnpm --filter … start`.
# `pnpm run` does NOT forward SIGTERM to the node child, so the graceful-shutdown
# handler in src/index.ts never fired on an ECS rolling deploy — the task was
# killed mid-batch and its in-flight SQS messages stayed invisible for the full
# visibility timeout before redelivering (the ingest-lag sawtooth that paged on
# every deploy). Running node as the container's main process delivers SIGTERM
# straight to the handler. Mirrors the package.json "start" script.
WORKDIR /app/apps/proxy
CMD ["node", "--import", "tsx", "--import", "./tracing.ts", "src/index.ts"]
