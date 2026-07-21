import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("an unauthenticated invitee sees the dedicated invitation authentication screen", async () => {
  const source = await readFile(new URL("./AcceptInvitation.tsx", import.meta.url), "utf8");
  const authenticationScreen = source.slice(
    source.indexOf("function InvitationAuthentication"),
    source.indexOf("function AcceptInvitationInner"),
  );

  assert.match(source, /return <InvitationAuthentication id=\{id\} \/>;/);
  assert.match(source, /function InvitationAuthentication\(/);
  assert.match(authenticationScreen, /You(?:'|&apos;)ve been invited to join an organization\./);
  assert.doesNotMatch(authenticationScreen, /getInvitation/);
  assert.match(source, /onSuccess=\{\(\) => window\.location\.assign\(/);
  assert.match(source, /accept-invitation\?id=\$\{encodeURIComponent\(id\)\}&join=1/);
  assert.match(source, /autoAccept=\{params\.get\("join"\) === "1"\}/);
});

test("automatic acceptance tries once, leaving a failed invitation available for a manual retry", async () => {
  const source = await readFile(new URL("./AcceptInvitation.tsx", import.meta.url), "utf8");

  assert.match(source, /const autoAcceptAttempted = useRef\(false\);/);
  assert.match(source, /if \(autoAcceptAttempted\.current\) return;/);
});

test("invitation acceptance failures retain enough context for client diagnostics", async () => {
  const source = await readFile(new URL("./AcceptInvitation.tsx", import.meta.url), "utf8");

  assert.match(source, /\[AcceptInvitation\] acceptInvitation failed/);
  assert.match(source, /invitationId: id/);
  assert.match(source, /\[AcceptInvitation\] setActive failed after acceptance/);
  assert.match(source, /organizationId: orgId/);
});
