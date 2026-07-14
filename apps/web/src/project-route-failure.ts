import { ApiError } from "./api-error.ts";

export type ProjectRouteFailureKind = "unavailable" | "retryable";

export function projectRouteFailureKind(error: unknown): ProjectRouteFailureKind {
  return error instanceof ApiError && error.status === 404 ? "unavailable" : "retryable";
}
