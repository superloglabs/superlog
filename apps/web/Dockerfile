# Build context: repo root. Build with `docker build -f apps/web/Dockerfile .`
# VITE_* vars must be passed as build args (Vite inlines them at build time).
FROM node:20-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter @superlog/web...

COPY tsconfig.base.json ./
COPY apps/web apps/web

ARG VITE_API_URL
ARG VITE_OTEL_EXPORTER_OTLP_ENDPOINT
ARG VITE_OTEL_EXPORTER_OTLP_HEADERS
ARG VITE_OTEL_SERVICE_NAME
ARG VITE_GTM_CONTAINER_ID
ARG VITE_ATTRIBUTION_COOKIE_DOMAIN
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_OTEL_EXPORTER_OTLP_ENDPOINT=$VITE_OTEL_EXPORTER_OTLP_ENDPOINT
ENV VITE_OTEL_EXPORTER_OTLP_HEADERS=$VITE_OTEL_EXPORTER_OTLP_HEADERS
ENV VITE_OTEL_SERVICE_NAME=$VITE_OTEL_SERVICE_NAME
ENV VITE_GTM_CONTAINER_ID=$VITE_GTM_CONTAINER_ID
ENV VITE_ATTRIBUTION_COOKIE_DOMAIN=$VITE_ATTRIBUTION_COOKIE_DOMAIN

RUN pnpm --filter @superlog/web build

FROM node:20-slim

RUN npm install -g serve@14

COPY --from=build /app/apps/web/dist /app/dist

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "serve -s /app/dist -l ${PORT}"]
