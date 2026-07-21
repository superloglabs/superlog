import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IncidentActivityFeed } from "./IncidentTranscript.tsx";

test("an active investigation ends the transcript with rotating progress copy", () => {
  const html = renderToStaticMarkup(<IncidentActivityFeed events={[]} investigating />);

  assert.match(html, /<output/);
  assert.match(html, /<output[^>]*class="[^"]*flex-1/);
  assert.match(html, /Investigation in progress/);
  assert.doesNotMatch(html, /border-accent\/40|rounded-full[^>]*investigation-progress-dot/);
  assert.doesNotMatch(html, /w-px bg-border/);
  assert.match(html, /class="-ml-\[18px\] -mt-1\.5 mb-6/);
  for (const phrase of [
    "Looking for evidence",
    "Following the signal",
    "Checking recent changes",
    "Connecting the clues",
    "Tracing the failure path",
    "Comparing related events",
    "Testing likely causes",
    "Reviewing the surrounding code",
    "Ruling out false leads",
    "Building the incident timeline",
  ]) {
    assert.match(html, new RegExp(phrase));
  }
});
