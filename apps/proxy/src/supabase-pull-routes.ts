import type { Env, Handler, Hono, MiddlewareHandler } from "hono";

export function mountSupabaseMetricsPullRoute<E extends Env>(
  app: Hono<E>,
  input: {
    validateIngestKey: MiddlewareHandler<E>;
    forward: Handler<E>;
  },
): void {
  app.use("/supabase/pull/*", input.validateIngestKey);
  app.post("/supabase/pull/metrics", input.forward);
}
