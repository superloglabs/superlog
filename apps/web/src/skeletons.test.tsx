import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SkeletonBlock } from "./design/ui.tsx";
import {
  ExploreSignalDetailSkeleton,
  ExploreSignalListSkeleton,
  IncidentDetailSkeleton,
  IncidentListSkeleton,
  IssueDetailSkeleton,
  IssueListSkeleton,
  MetricDetailSkeleton,
} from "./skeletons.tsx";

test("skeleton blocks expose an accessible loading label", () => {
  const html = renderToStaticMarkup(<SkeletonBlock label="Loading incident title" />);

  assert.match(html, /aria-label="Loading incident title"/);
  assert.match(html, /animate-pulse/);
});

test("issue skeletons cover list and detail loading surfaces", () => {
  const list = renderToStaticMarkup(<IssueListSkeleton />);
  const detail = renderToStaticMarkup(<IssueDetailSkeleton />);

  assert.match(list, /aria-label="Loading issues"/);
  assert.match(detail, /aria-label="Loading issue detail"/);
});

test("incident skeletons cover list and detail loading surfaces", () => {
  const list = renderToStaticMarkup(<IncidentListSkeleton />);
  const detail = renderToStaticMarkup(<IncidentDetailSkeleton />);

  assert.match(list, /aria-label="Loading incidents"/);
  assert.match(detail, /aria-label="Loading incident detail"/);
});

test("explore skeletons cover logs, traces, and metrics list and detail surfaces", () => {
  for (const source of ["logs", "traces", "metrics"] as const) {
    const list = renderToStaticMarkup(<ExploreSignalListSkeleton source={source} />);
    const detail = renderToStaticMarkup(<ExploreSignalDetailSkeleton source={source} />);

    assert.match(list, new RegExp(`aria-label="Loading ${source}"`));
    assert.match(detail, new RegExp(`aria-label="Loading ${source} detail"`));
  }

  const metricDetail = renderToStaticMarkup(<MetricDetailSkeleton />);
  assert.match(metricDetail, /aria-label="Loading metric detail"/);
});
