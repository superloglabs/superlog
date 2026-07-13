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

test("skeleton blocks are decorative and respect reduced motion", () => {
  const html = renderToStaticMarkup(<SkeletonBlock />);

  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /aria-label=/);
  assert.match(html, /motion-safe:animate-pulse/);
});

test("error skeletons cover list and detail loading surfaces", () => {
  const list = renderToStaticMarkup(<IssueListSkeleton />);
  const detail = renderToStaticMarkup(<IssueDetailSkeleton />);

  assert.match(list, /role="status"/);
  assert.match(detail, /role="status"/);
  assert.match(list, /aria-label="Loading errors"/);
  assert.match(detail, /aria-label="Loading error detail"/);
});

test("incident skeletons cover list and detail loading surfaces", () => {
  const list = renderToStaticMarkup(<IncidentListSkeleton />);
  const detail = renderToStaticMarkup(<IncidentDetailSkeleton />);

  assert.match(list, /role="status"/);
  assert.match(detail, /role="status"/);
  assert.match(list, /aria-label="Loading incidents"/);
  assert.match(detail, /aria-label="Loading incident detail"/);
});

test("explore skeletons cover logs, traces, and metrics list and detail surfaces", () => {
  const expectedColumns = { logs: 4, traces: 5, metrics: 6 };
  for (const source of ["logs", "traces", "metrics"] as const) {
    const list = renderToStaticMarkup(<ExploreSignalListSkeleton source={source} />);
    const detail = renderToStaticMarkup(<ExploreSignalDetailSkeleton source={source} />);

    assert.match(list, /role="status"/);
    assert.match(detail, /role="status"/);
    assert.match(list, new RegExp(`aria-label="Loading ${source}"`));
    assert.match(detail, new RegExp(`aria-label="Loading ${source} detail"`));
    assert.match(
      list,
      new RegExp(
        `grid-template-columns:repeat\\(${expectedColumns[source]},\\s*minmax\\(0,\\s*1fr\\)\\)`,
      ),
    );
  }

  const metricDetail = renderToStaticMarkup(<MetricDetailSkeleton />);
  assert.match(metricDetail, /role="status"/);
  assert.match(metricDetail, /aria-label="Loading metric detail"/);
});
