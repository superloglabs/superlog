import assert from "node:assert/strict";
import test from "node:test";
import { railwayCallbackView } from "./railwayCallbackModel.ts";

test("installed carries the outcome back so the wizard resumes the Railway flow", () => {
  const view = railwayCallbackView("installed");
  assert.equal(view.tone, "success");
  // The wizard reads `?railway=` on `/` to drop into the flow's connected
  // panel (waiting for first events) instead of the integration chooser.
  assert.equal(view.backHref, "/app?railway=installed");
  assert.match(view.body, /pulling logs and infra metrics/i);
});

test("failure outcomes carry the outcome back to /app so the wizard resets", () => {
  for (const outcome of ["denied", "error", "no_projects"] as const) {
    const view = railwayCallbackView(outcome);
    assert.equal(view.tone, "error", outcome);
    assert.equal(view.backHref, `/app?railway=${outcome}`);
  }
});

test("no_projects explains the consent-screen project picker", () => {
  assert.match(railwayCallbackView("no_projects").body, /consent screen/i);
});

test("missing or unknown outcomes render the fallback view", () => {
  for (const raw of [null, undefined, "", "wat"]) {
    const view = railwayCallbackView(raw);
    assert.equal(view.tone, "error");
    assert.equal(view.backHref, "/app");
  }
});
