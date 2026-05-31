# Build context: repo root. Build with `docker build -f apps/worker/Dockerfile .`
FROM node:20-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/fingerprint/package.json packages/fingerprint/

RUN pnpm install --frozen-lockfile --filter @superlog/worker...

COPY tsconfig.base.json ./
COPY apps/worker apps/worker
COPY packages/db packages/db
COPY packages/fingerprint packages/fingerprint

CMD ["pnpm", "--filter", "@superlog/worker", "start"]
