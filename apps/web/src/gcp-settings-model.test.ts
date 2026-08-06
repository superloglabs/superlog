import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gcpConnectAction, gcpLogGroupLabel, mergeGcpLogNames } from "./gcp-settings-model.js";

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

test("GCP log groups use the readable decoded portion of a full log name", () => {
  assert.equal(
    gcpLogGroupLabel("projects/acme-production/logs/run.googleapis.com%2Fstderr"),
    "run.googleapis.com/stderr",
  );
});

test("saved GCP exclusions stay editable when they are outside the discovery window", () => {
  assert.deepEqual(
    mergeGcpLogNames(
      ["projects/acme-production/logs/run.googleapis.com%2Fstdout"],
      ["projects/acme-production/logs/run.googleapis.com%2Fstderr"],
    ),
    [
      "projects/acme-production/logs/run.googleapis.com%2Fstderr",
      "projects/acme-production/logs/run.googleapis.com%2Fstdout",
    ],
  );
});
