import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FacetValues, facetDisplayName } from "./FacetValues.tsx";

test("facetDisplayName turns scoped telemetry keys into capitalized labels", () => {
  assert.equal(facetDisplayName("resource.service.name"), "Service name");
  assert.equal(facetDisplayName("span.http.request.method"), "Http request method");
  assert.equal(facetDisplayName("log.exception_type"), "Exception type");
});

test("facet values expose toggle state and event counts", () => {
  const html = renderToStaticMarkup(
    <FacetValues
      facetLabel="service.name"
      values={[
        { value: "api", label: "api", count: 42 },
        { value: "worker", label: "worker", count: 7 },
      ]}
      selectedValues={new Set(["api"])}
      onToggle={() => {}}
    />,
  );

  assert.match(html, /type="checkbox"/);
  assert.match(html, /aria-label="service\.name: api"/);
  assert.match(html, /checked=""/);
  assert.match(html, />42</);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
});
