import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FacetValues, facetDisplayName, facetMatchesQuery } from "./FacetValues.tsx";

test("facetDisplayName turns scoped telemetry keys into capitalized labels", () => {
  assert.equal(facetDisplayName("resource.service.name"), "Resource · Service name");
  assert.equal(facetDisplayName("span.http.request.method"), "Span · Http request method");
  assert.equal(facetDisplayName("log.exception_type"), "Log · Exception type");
  assert.equal(facetDisplayName("service.name"), "Service name");
});

test("facetMatchesQuery finds the words users see in a humanized facet label", () => {
  assert.equal(facetMatchesQuery("resource.service.name", "service name"), true);
  assert.equal(facetMatchesQuery("resource.service.name", "resource service"), true);
  assert.equal(facetMatchesQuery("span.http.request.method", "http request"), true);
  assert.equal(facetMatchesQuery("span.http.request.method", "log request"), false);
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
