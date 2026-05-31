# Build context: repo root (Railway default). Build with `docker build -f infra/collector/Dockerfile .`
FROM golang:1.24-alpine AS entrypoint

WORKDIR /src
COPY infra/collector/entrypoint.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /collector-entrypoint entrypoint.go

FROM otel/opentelemetry-collector-contrib:0.150.1

COPY --from=entrypoint /collector-entrypoint /collector-entrypoint
COPY infra/collector/config.yaml /etc/otelcol-contrib/config.yaml
COPY infra/collector/config-dual-clickhouse.yaml /etc/otelcol-contrib/config-dual-clickhouse.yaml

ENTRYPOINT ["/collector-entrypoint"]
CMD []
