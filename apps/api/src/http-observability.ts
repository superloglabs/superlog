import { trace } from "@opentelemetry/api";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

type MetricAttributes = Record<string, string | number | boolean>;

export type ApiSpanAttributeInput = {
  method: string;
  path: string;
  routePath?: string;
  statusCode: number;
  orgId?: string | null;
  userId?: string | null;
};

function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

function isDynamicSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return true;
  }
  if (/^(project|org|user|inc|sui|key)_[a-z0-9]+$/i.test(segment)) return true;
  if (/^[a-z][a-z0-9]*_[a-z0-9]{8,}$/i.test(segment)) return true;
  return segment.length >= 20 && /[0-9]/.test(segment) && /^[a-z0-9_-]+$/i.test(segment);
}

export function normalizeHttpRoute(rawPath: string): string {
  const path = rawPath.split("?")[0] || "/";
  return path
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (segment.startsWith(":")) return segment;
      return isDynamicSegment(segment) ? ":id" : segment;
    })
    .join("/");
}

function routeName(input: Pick<ApiSpanAttributeInput, "path" | "routePath">): string {
  return input.routePath && input.routePath !== "*" && input.routePath !== "/api/*"
    ? input.routePath
    : normalizeHttpRoute(input.path);
}

function extractProjectId(path: string): string | null {
  const match = path.match(/^\/api\/(?:org\/)?(?:v1\/)?projects\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export function buildApiSpanAttributes(input: ApiSpanAttributeInput): MetricAttributes {
  const endpoint = routeName(input);
  const attrs: MetricAttributes = {
    "http.request.method": input.method.toUpperCase(),
    "http.route": endpoint,
    "superlog.endpoint": endpoint,
    "http.response.status_code": input.statusCode,
    "http.response.status_class": statusClass(input.statusCode),
  };
  if (input.orgId) attrs["tenant.org.id"] = input.orgId;
  if (input.userId) attrs["enduser.id"] = input.userId;
  const projectId = extractProjectId(input.path);
  if (projectId) attrs["tenant.project.id"] = projectId;
  return attrs;
}

type ApiObservabilityVars = {
  userId?: string;
  orgId?: string | null;
};

export function createApiHttpObservabilityMiddleware(): (
  c: Context<{ Variables: ApiObservabilityVars }>,
  next: Next,
) => Promise<void> {
  return async (c, next) => {
    let statusCode = 500;

    try {
      await next();
      statusCode = c.res.status;
    } catch (err) {
      statusCode = err instanceof HTTPException ? err.status : 500;
      throw err;
    } finally {
      trace.getActiveSpan()?.setAttributes(
        buildApiSpanAttributes({
          method: c.req.method,
          path: c.req.path,
          routePath: c.req.routePath,
          statusCode,
          orgId: c.var.orgId,
          userId: c.var.userId,
        }),
      );
    }
  };
}
