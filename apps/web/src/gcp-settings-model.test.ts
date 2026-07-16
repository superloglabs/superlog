import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gcpConnectAction } from "./gcp-settings-model.js";

test("a connected GCP integration offers a project replacement action", () => {
  assert.deepEqual(gcpConnectAction("connected"), {
    buttonLabel: "Change Google Cloud project",
  });
});

test("an unconnected GCP integration offers the initial connect action", () => {
  assert.deepEqual(gcpConnectAction("failed"), {
    buttonLabel: "Connect Google Cloud",
  });
});
