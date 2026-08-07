import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  canToggleGcpLogGroup,
  gcpConnectAction,
  gcpLogDiscoveryRange,
  gcpLogGroupLabel,
  mergeGcpLogNames,
} from "./gcp-settings-model.js";

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

test("GCP log group discovery stays within the latest day", () => {
  assert.deepEqual(gcpLogDiscoveryRange(new Date("2026-08-07T12:00:00.000Z")), {
    since: "2026-08-06T12:00:00.000Z",
    until: "2026-08-07T12:00:00.000Z",
  });
});

test("the exclusion cap blocks another disable but still allows re-enabling a group", () => {
  assert.equal(canToggleGcpLogGroup(true, 200, 200), false);
  assert.equal(canToggleGcpLogGroup(false, 200, 200), true);
  assert.equal(canToggleGcpLogGroup(true, 199, 200), true);
});
