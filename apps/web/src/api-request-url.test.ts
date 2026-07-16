import { strict as assert } from "node:assert";
import { test } from "node:test";
import { apiRequestUrl } from "./api.ts";

test("API requests preserve an absolute endpoint supplied by an embedding surface", () => {
	assert.equal(
		apiRequestUrl(
			"https://staff-api.example/api/incidents/incident-1/pull-requests/pr-1/diff",
			"https://product-api.example",
		),
		"https://staff-api.example/api/incidents/incident-1/pull-requests/pr-1/diff",
	);
});

test("API requests still resolve product-relative paths against the product API", () => {
	assert.equal(
		apiRequestUrl("/api/incidents/incident-1", "https://product-api.example"),
		"https://product-api.example/api/incidents/incident-1",
	);
});
