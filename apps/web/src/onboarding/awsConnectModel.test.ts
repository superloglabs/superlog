import assert from "node:assert/strict";
import test from "node:test";
import { AWS_REGION_CODES, DEFAULT_AWS_REGION } from "../awsRegions.ts";
import {
  activeConnection,
  awsPhase,
  awsStreamFlowing,
  canContinueAws,
  connectionStatusText,
  isValidRegion,
  stackComponentTone,
} from "./awsConnectModel.ts";

test("default region is one of the offered regions", () => {
  assert.ok(AWS_REGION_CODES.includes(DEFAULT_AWS_REGION));
});

test("isValidRegion mirrors the API guard", () => {
  for (const r of AWS_REGION_CODES) assert.equal(isValidRegion(r), true);
  assert.equal(isValidRegion(""), false);
  assert.equal(isValidRegion("US-EAST-1"), false); // uppercase rejected
  assert.equal(isValidRegion("us east 1"), false); // spaces rejected
  assert.equal(isValidRegion("a".repeat(33)), false); // too long
});

test("awsPhase walks start -> launching -> connected -> flowing", () => {
  assert.equal(awsPhase({ connection: null, streamFlowing: false }), "start");
  assert.equal(awsPhase({ connection: { status: "pending" }, streamFlowing: false }), "launching");
  assert.equal(awsPhase({ connection: { status: "failed" }, streamFlowing: false }), "launching");
  assert.equal(
    awsPhase({ connection: { status: "account_mismatch" }, streamFlowing: false }),
    "launching",
  );
  assert.equal(
    awsPhase({ connection: { status: "connected" }, streamFlowing: false }),
    "connected",
  );
  assert.equal(awsPhase({ connection: { status: "connected" }, streamFlowing: true }), "flowing");
});

test("a flowing stream before verify still requires the connection to be verified", () => {
  // Defensive: a stray signal shouldn't unlock the flow while pending.
  assert.equal(awsPhase({ connection: { status: "pending" }, streamFlowing: true }), "launching");
});

test("awsStreamFlowing only counts this connection's metric/log delivery", () => {
  assert.equal(awsStreamFlowing(undefined), false);
  assert.equal(awsStreamFlowing([]), false);
  // The connection row being "working" is not telemetry delivery.
  assert.equal(awsStreamFlowing([{ key: "connection", state: "working" }]), false);
  // A pending/missing stream hasn't delivered yet.
  assert.equal(awsStreamFlowing([{ key: "metrics", state: "pending" }]), false);
  // A working metric or log stream means real Firehose delivery.
  assert.equal(awsStreamFlowing([{ key: "metrics", state: "working" }]), true);
  assert.equal(awsStreamFlowing([{ key: "logs", state: "working" }]), true);
});

test("canContinueAws only unlocks once telemetry is flowing", () => {
  assert.equal(canContinueAws("start"), false);
  assert.equal(canContinueAws("launching"), false);
  assert.equal(canContinueAws("connected"), false);
  assert.equal(canContinueAws("flowing"), true);
});

test("stackComponentTone maps API states to chip tones", () => {
  assert.equal(stackComponentTone("working"), "success");
  assert.equal(stackComponentTone("pending"), "warning");
  assert.equal(stackComponentTone("broken"), "danger");
  assert.equal(stackComponentTone("missing"), "muted");
});

test("connectionStatusText surfaces the failure reason", () => {
  assert.equal(connectionStatusText("connected", null), "Connected");
  assert.equal(connectionStatusText("pending", null), "Waiting for the stack…");
  assert.match(connectionStatusText("failed", "AccessDenied"), /AccessDenied/);
  assert.match(connectionStatusText("account_mismatch", null), /account/i);
});

test("activeConnection picks the most recently created row", () => {
  assert.equal(activeConnection(undefined), null);
  assert.equal(activeConnection([]), null);
  const rows = [
    { id: "old", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "new", createdAt: "2026-06-01T00:00:00.000Z" },
    { id: "mid", createdAt: "2026-03-01T00:00:00.000Z" },
  ];
  assert.equal(activeConnection(rows)?.id, "new");
});
