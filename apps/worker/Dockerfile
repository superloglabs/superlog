# Build context: repo root. Build with `docker build -f apps/worker/Dockerfile .`
# Node 22 (LTS): required by pg-boss v12, which backs the background job runner.
FROM node:22-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages packages

RUN pnpm install --frozen-lockfile --filter @superlog/worker...

COPY tsconfig.base.json ./
COPY apps/worker apps/worker

RUN pnpm --filter @superlog/worker typecheck

CMD ["pnpm", "--filter", "@superlog/worker", "start"]
