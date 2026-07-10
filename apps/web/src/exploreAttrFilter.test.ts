import assert from "node:assert/strict";
import test from "node:test";
import {
  addAttrFilter,
  attrFilterKey,
  toggleAttrFilter,
  toggleSingleFacetValue,
} from "./exploreAttrFilter.ts";

test("attrFilterKey prefixes the key with its attribute scope", () => {
  assert.equal(attrFilterKey("resource", "service.name"), "resource.service.name");
  assert.equal(attrFilterKey("log", "level"), "log.level");
  assert.equal(attrFilterKey("span", "http.method"), "span.http.method");
});

test("addAttrFilter appends a new eq filter", () => {
  assert.deepEqual(addAttrFilter([], "log.level", "error"), [{ key: "log.level", value: "error" }]);
  assert.deepEqual(
    addAttrFilter([{ key: "resource.service.name", value: "api" }], "log.level", "error"),
    [
      { key: "resource.service.name", value: "api" },
      { key: "log.level", value: "error" },
    ],
  );
});

test("addAttrFilter ignores an exact duplicate eq pair", () => {
  const existing = [{ key: "log.level", value: "error" }];
  assert.equal(addAttrFilter(existing, "log.level", "error"), existing);
});

test("addAttrFilter treats an explicit eq op as a duplicate of an unspecified op", () => {
  const existing = [{ key: "log.level", value: "error", op: "eq" as const }];
  assert.equal(addAttrFilter(existing, "log.level", "error"), existing);
});

test("addAttrFilter adds an eq filter even when a neq on the same pair exists", () => {
  const existing = [{ key: "log.level", value: "error", op: "neq" as const }];
  assert.deepEqual(addAttrFilter(existing, "log.level", "error"), [
    { key: "log.level", value: "error", op: "neq" },
    { key: "log.level", value: "error" },
  ]);
});

test("addAttrFilter allows the same key with a different value", () => {
  const existing = [{ key: "resource.service.name", value: "api" }];
  assert.deepEqual(addAttrFilter(existing, "resource.service.name", "web"), [
    { key: "resource.service.name", value: "api" },
    { key: "resource.service.name", value: "web" },
  ]);
});

test("toggleAttrFilter selects, replaces, and clears a facet value", () => {
  const existing = [
    { key: "resource.service.name", value: "api" },
    { key: "resource.deployment.environment", value: "prod" },
  ];

  assert.deepEqual(toggleAttrFilter(existing, "resource.service.name", "web"), [
    { key: "resource.deployment.environment", value: "prod" },
    { key: "resource.service.name", value: "web" },
  ]);
  assert.deepEqual(toggleAttrFilter(existing, "resource.service.name", "api"), [
    { key: "resource.deployment.environment", value: "prod" },
  ]);
});

test("toggleSingleFacetValue selects, replaces, and clears a single-value facet", () => {
  assert.equal(toggleSingleFacetValue("", "ERROR"), "ERROR");
  assert.equal(toggleSingleFacetValue("WARN", "ERROR"), "ERROR");
  assert.equal(toggleSingleFacetValue("ERROR", "ERROR"), "");
});
