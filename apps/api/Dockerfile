# Build context: repo root. Build with `docker build -f apps/api/Dockerfile .`
FROM node:22-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
# Copy every workspace package rather than enumerating them: three separate
# deploys have broken when a new package (topology, net-guard, railway) was
# added as an app dependency without extending a hand-maintained COPY list.
# The install layer re-runs more often, but images stop silently missing
# packages.
COPY packages packages

RUN pnpm install --frozen-lockfile --filter @superlog/api...

COPY tsconfig.base.json ./
COPY apps/api apps/api

# Fail the build, not the deployed task, when a module cannot resolve — a
# missing workspace package previously produced an image that crash-looped
# at boot (ERR_MODULE_NOT_FOUND) while ECS kept the old task set serving.
RUN pnpm --filter @superlog/api typecheck

ENV PORT=4100
EXPOSE 4100

CMD ["pnpm", "--filter", "@superlog/api", "start"]
