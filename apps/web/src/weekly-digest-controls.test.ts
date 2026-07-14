import assert from "node:assert/strict";
import test from "node:test";
import {
  weeklyDigestChannelSelection,
  weeklyDigestStatusDescription,
  weeklyDigestToggleDisabled,
} from "./weekly-digest-controls.ts";

const channels = [
  { id: "C1", name: "superlog-prod" },
  { id: "C2", name: "alerts" },
];

test("selecting a channel enables the digest in the same save", () => {
  assert.deepEqual(weeklyDigestChannelSelection("C1", channels), {
    channelId: "C1",
    channelName: "superlog-prod",
    enabled: true,
  });
});

test("selecting a channel missing from the list still enables, without a name", () => {
  assert.deepEqual(weeklyDigestChannelSelection("C9", channels), {
    channelId: "C9",
    channelName: null,
    enabled: true,
  });
});

test("an empty selection is a no-op, not a disable", () => {
  assert.equal(weeklyDigestChannelSelection("", channels), null);
});

test("the toggle only blocks turning on without a channel", () => {
  assert.equal(
    weeklyDigestToggleDisabled({ enabled: false, channelId: "", saving: false }),
    true,
  );
  assert.equal(
    weeklyDigestToggleDisabled({ enabled: false, channelId: "C1", saving: false }),
    false,
  );
  // an enabled digest can always be turned off, even if the channel is somehow gone
  assert.equal(
    weeklyDigestToggleDisabled({ enabled: true, channelId: "", saving: false }),
    false,
  );
  assert.equal(
    weeklyDigestToggleDisabled({ enabled: true, channelId: "C1", saving: true }),
    true,
  );
});

test("status description explains the unconfigured state instead of a bare disabled toggle", () => {
  assert.equal(
    weeklyDigestStatusDescription({
      enabled: false,
      channelId: "",
      channelName: null,
      lastRunLabel: "Never sent",
    }),
    "Pick a channel below to start posting",
  );
});

test("status description shows the destination while enabled and a paused state while off", () => {
  assert.equal(
    weeklyDigestStatusDescription({
      enabled: true,
      channelId: "C1",
      channelName: "superlog-prod",
      lastRunLabel: "Never sent",
    }),
    "Posting to #superlog-prod · Never sent",
  );
  assert.equal(
    weeklyDigestStatusDescription({
      enabled: true,
      channelId: "C1",
      channelName: null,
      lastRunLabel: "Never sent",
    }),
    "Posting to #C1 · Never sent",
  );
  assert.equal(
    weeklyDigestStatusDescription({
      enabled: false,
      channelId: "C1",
      channelName: "superlog-prod",
      lastRunLabel: "Last sent 7/10/2026",
    }),
    "Paused · Last sent 7/10/2026",
  );
});
