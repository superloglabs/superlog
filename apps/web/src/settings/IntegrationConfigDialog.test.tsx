import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationConfigDialog } from "./IntegrationConfigDialog.tsx";

test("renders a modal dialog with the integration header and config content", () => {
  const html = renderToStaticMarkup(
    <IntegrationConfigDialog
      title="GitHub"
      subtitle="Review the connection, update access, or disconnect it."
      status={<span>2 accounts</span>}
      onClose={() => {}}
    >
      <p>config body</p>
    </IntegrationConfigDialog>,
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /GitHub/);
  assert.match(html, /Review the connection/);
  assert.match(html, /2 accounts/);
  assert.match(html, /config body/);
  // Both dismissal affordances are labelled: the scrim and the header X.
  assert.match(html, /aria-label="Close dialog"/);
  assert.match(html, /aria-label="Close"/);
});

test("omits the status slot when none is given", () => {
  const html = renderToStaticMarkup(
    <IntegrationConfigDialog
      title="Notion"
      subtitle="Give investigations access to shared runbooks."
      onClose={() => {}}
    >
      <p>connect body</p>
    </IntegrationConfigDialog>,
  );

  assert.match(html, /Notion/);
  assert.match(html, /connect body/);
});
