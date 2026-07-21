import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueFrequencySparkline } from "./issues/IssueFrequencySparkline.tsx";
import { DEFAULT_ISSUE_LIST_FILTER, issueListSearchParams } from "./issues/issue-list-model.ts";

test("errors open on the status tab with a 12-day last-seen filter", () => {
  assert.deepEqual(DEFAULT_ISSUE_LIST_FILTER, { status: "open", window: "12d" });
  assert.equal(
    issueListSearchParams(DEFAULT_ISSUE_LIST_FILTER).toString(),
    "status=open&recentDays=12",
  );
});

test("errors can keep the selected status while showing any time", () => {
  assert.equal(
    issueListSearchParams({ status: "resolved", window: "all" }).toString(),
    "status=resolved&recentDays=all",
  );
});

test("an error row shows the same 12-day frequency sparkline used by incidents", () => {
  const html = renderToStaticMarkup(
    createElement(IssueFrequencySparkline, {
      buckets: Array.from({ length: 12 }, (_, index) => ({
        day: `2026-07-${String(index + 10).padStart(2, "0")}`,
        count: index === 10 ? 17 : index === 9 ? 4 : 0,
      })),
    }),
  );

  assert.match(html, /aria-label="Last 12 days activity"/);
  assert.match(html, /17 events/);
});
