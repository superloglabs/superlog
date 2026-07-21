import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InactiveIncidentResolutionCard } from "./settings/InactiveIncidentResolutionCard.tsx";

test("inactive incident resolution is presented as a standalone settings card", () => {
  const html = renderToStaticMarkup(
    createElement(InactiveIncidentResolutionCard, {
      enabled: true,
      disabled: false,
      onChange: () => {},
    }),
  );

  assert.match(html, /<section[^>]*aria-labelledby="inactive-incident-resolution-title"/);
  assert.match(
    html,
    /<h2 id="inactive-incident-resolution-title"[^>]*>Auto-resolve inactive incidents<\/h2>/,
  );
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
});
