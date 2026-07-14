import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "./api-error.ts";
import { ProjectRouteFailure } from "./ProjectRouteBoundary.tsx";
import { projectRouteFailureKind } from "./project-route-failure.ts";

test("missing or inaccessible projects are unavailable", () => {
  assert.equal(projectRouteFailureKind(new ApiError(404, "Not found")), "unavailable");
});

test("operational failures can be retried", () => {
  assert.equal(projectRouteFailureKind(new ApiError(500, "Try again")), "retryable");
  assert.equal(projectRouteFailureKind(new TypeError("Failed to fetch")), "retryable");
});

test("operational failures offer a retry without describing the project as unavailable", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectRouteFailure, {
      error: new ApiError(500, "Try again"),
      onRetry: () => {},
    }),
  );

  assert.match(html, /Couldn’t open project/);
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, /does not exist/);
});
