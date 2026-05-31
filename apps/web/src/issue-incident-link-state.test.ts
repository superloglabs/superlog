import assert from "node:assert/strict";
import test from "node:test";
import { getIssueIncidentLinkState } from "./issue-incident-link-state.ts";

test("prefers a real incident link over stale standalone grouping state", () => {
  assert.equal(
    getIssueIncidentLinkState({
      groupingState: "standalone",
      incident: {
        id: "inc_123",
      } as never,
      isLoading: false,
    }),
    "linked",
  );
});

test("returns standalone when loading is complete and no incident is linked", () => {
  assert.equal(
    getIssueIncidentLinkState({
      groupingState: "standalone",
      incident: null,
      isLoading: false,
    }),
    "standalone",
  );
});
