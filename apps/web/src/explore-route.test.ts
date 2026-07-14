import assert from "node:assert/strict";
import test from "node:test";
import { sourceFromExplorePath } from "./explore-route.ts";

test("scoped Explore URLs select their requested telemetry source", () => {
  assert.equal(
    sourceFromExplorePath("/org/acme/project/default/explore/traces"),
    "traces",
  );
});
