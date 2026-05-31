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

CMD ["pnpm", "--filter", "@superlog/proxy", "start"]
