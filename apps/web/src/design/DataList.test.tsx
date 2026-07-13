import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DataList, DataListCell, DataListHeader, DataListHeaderCell, DataListRow } from "./ui.tsx";

test("dense lists expose table structure without introducing a second visual language", () => {
  const html = renderToStaticMarkup(
    <DataList label="Alert rules">
      <DataListHeader>
        <DataListHeaderCell>Name</DataListHeaderCell>
        <DataListHeaderCell>Status</DataListHeaderCell>
      </DataListHeader>
      <DataListRow>
        <DataListCell>Checkout latency</DataListCell>
        <DataListCell>Enabled</DataListCell>
      </DataListRow>
    </DataList>,
  );

  assert.match(html, /role="table"/);
  assert.match(html, /aria-label="Alert rules"/);
  assert.match(html, /role="columnheader"/);
  assert.match(html, /role="row"/);
  assert.doesNotMatch(html, /font-mono|uppercase/);
});
