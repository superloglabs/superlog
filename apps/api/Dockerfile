# Build context: repo root. Build with `docker build -f apps/api/Dockerfile .`
FROM node:20-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/fingerprint/package.json packages/fingerprint/

RUN pnpm install --frozen-lockfile --filter @superlog/api...

COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/db packages/db
COPY packages/fingerprint packages/fingerprint

ENV PORT=4100
EXPOSE 4100

CMD ["pnpm", "--filter", "@superlog/api", "start"]
