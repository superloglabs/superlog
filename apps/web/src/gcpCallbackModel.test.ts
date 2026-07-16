import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gcpCallbackView } from "./gcpCallbackModel.js";

test("GCP callback explains successful zero-customer-cost setup", () => {
  assert.deepEqual(gcpCallbackView("connected"), {
    tone: "success",
    title: "Google Cloud connected",
    body: "Logs are streaming and bounded metric collection is enabled. Superlog pays for Pub/Sub and Monitoring API reads.",
    backLabel: "Back to settings",
    backHref: "/settings",
  });
});

test("GCP callback gives a useful retry path after failure", () => {
  assert.equal(gcpCallbackView("error").tone, "error");
  assert.match(gcpCallbackView("denied").body, /not granted/);
});

test("GCP callback introduces project selection after authorization", () => {
  assert.deepEqual(gcpCallbackView("select"), {
    tone: "neutral",
    title: "Choose a Google Cloud project",
    body: "Select one of the active projects available to your Google account.",
    backLabel: "Back to settings",
    backHref: "/settings",
  });
});
