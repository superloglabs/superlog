import { strict as assert } from "node:assert";
import { test } from "node:test";
import { orgInvitationEmailBody, passwordResetEmailBody, verificationEmailBody } from "./email.js";

test("verificationEmailBody keeps the raw url in text and an escaped copy in html", () => {
  const url = "https://api.superlog.sh/verify?token=a&b=2";
  const { text, html } = verificationEmailBody(url);

  // text body carries the raw URL untouched so the link is copy-pasteable
  assert.ok(text.includes(url));
  // html escapes the ampersand for both the href and the visible link text
  assert.ok(html.includes("https://api.superlog.sh/verify?token=a&amp;b=2"));
  assert.ok(!html.includes("token=a&b=2"));
});

test("verificationEmailBody escapes html-injection attempts in the url", () => {
  const url = 'https://api.superlog.sh/x"><script>alert(1)</script>';
  const { html } = verificationEmailBody(url);

  // none of the dangerous characters survive into the markup
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('"><'));
  assert.ok(html.includes("&quot;"));
  assert.ok(html.includes("&gt;"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("passwordResetEmailBody mentions expiry and escapes the url", () => {
  const url = "https://api.superlog.sh/reset?token=x&y=1";
  const { text, html } = passwordResetEmailBody(url);

  assert.ok(text.includes("expires in 1 hour"));
  assert.ok(text.includes(url));
  assert.ok(html.includes("https://api.superlog.sh/reset?token=x&amp;y=1"));
  assert.ok(!html.includes("token=x&y=1"));
});

test("orgInvitationEmailBody uses the inviter name when present", () => {
  const { text, html } = orgInvitationEmailBody({
    url: "https://api.superlog.sh/invite/abc",
    orgName: "Acme Inc.",
    inviterEmail: "alice@example.com",
    inviterName: "Alice",
    role: "admin",
  });

  assert.ok(text.startsWith("Alice invited you to join Acme Inc. on Superlog as admin."));
  assert.ok(html.includes("Alice invited you to join <strong>Acme Inc.</strong>"));
  assert.ok(html.includes("as admin."));
  // the inviter email is not used when a name is available
  assert.ok(!text.includes("alice@example.com"));
});

test("orgInvitationEmailBody falls back to inviter email when name is missing or blank", () => {
  for (const inviterName of [null, undefined, "", "   "]) {
    const { text, html } = orgInvitationEmailBody({
      url: "https://api.superlog.sh/invite/abc",
      orgName: "Acme Inc.",
      inviterEmail: "alice@example.com",
      inviterName,
      role: "member",
    });

    assert.ok(
      text.startsWith("alice@example.com invited you to join Acme Inc. on Superlog as member."),
      `expected email fallback for inviterName=${JSON.stringify(inviterName)}`,
    );
    assert.ok(html.includes("alice@example.com invited you to join"));
  }
});

test("orgInvitationEmailBody escapes org name, role, and inviter in the html body", () => {
  const { html } = orgInvitationEmailBody({
    url: 'https://api.superlog.sh/invite"><img>',
    orgName: "<b>Evil</b> Corp",
    inviterEmail: "alice@example.com",
    inviterName: '<script>alert("x")</script>',
    role: "<admin>",
  });

  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<b>Evil</b>"));
  assert.ok(!html.includes('"><img>'));
  assert.ok(html.includes("&lt;b&gt;Evil&lt;/b&gt; Corp"));
  assert.ok(html.includes("&lt;admin&gt;"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("orgInvitationEmailBody keeps the raw url in the text accept link", () => {
  const url = "https://api.superlog.sh/invite/abc?ref=email&x=1";
  const { text } = orgInvitationEmailBody({
    url,
    orgName: "Acme",
    inviterEmail: "a@b.com",
    inviterName: "A",
    role: "member",
  });

  assert.ok(text.includes(`Accept: ${url}`));
});
