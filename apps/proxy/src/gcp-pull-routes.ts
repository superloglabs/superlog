import type { Env, Handler, Hono, MiddlewareHandler } from "hono";

export function mountGcpMetricsPullRoute<E extends Env>(
  app: Hono<E>,
  input: {
    validateIngestKey: MiddlewareHandler<E>;
    forward: Handler<E>;
  },
): void {
  app.use("/gcp/pull/*", input.validateIngestKey);
  app.post("/gcp/pull/metrics", input.forward);
}
