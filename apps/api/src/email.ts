import { Resend } from "resend";
import { logger } from "./logger.js";

// Thin Resend wrapper used by Better Auth for verification + password reset
// emails. Dev fallback: when RESEND_API_KEY is unset, log the body to stderr
// instead of throwing — that lets worktree sign-ups continue to work without
// production-level email credentials.

const log = logger.child({ scope: "email" });

const FROM = process.env.SUPERLOG_FROM_EMAIL ?? "Superlog <no-reply@superlog.sh>";
const REPLY_TO = process.env.SUPERLOG_REPLY_TO_EMAIL;

let client: Resend | null = null;
function getClient(): Resend | null {
  if (client) return client;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  client = new Resend(key);
  return client;
}

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export async function sendEmail(message: EmailMessage): Promise<void> {
  const c = getClient();
  if (!c) {
    log.warn(
      { to: message.to, subject: message.subject },
      "RESEND_API_KEY not set — printing email body instead of sending",
    );
    log.info({ body: message.text }, "email body (dev fallback)");
    return;
  }
  const res = await c.emails.send({
    from: FROM,
    to: [message.to],
    replyTo: REPLY_TO,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
  if (res.error) {
    log.error({ err: res.error, to: message.to }, "resend send failed");
    throw new Error(`resend: ${res.error.message ?? "unknown"}`);
  }
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function verificationEmailBody(url: string): { html: string; text: string } {
  const safe = escape(url);
  return {
    text: `Confirm your email to start using Superlog.\n\n${url}\n\nIf you didn't sign up, you can ignore this email.`,
    html: `<p>Confirm your email to start using Superlog.</p>
<p><a href="${safe}">${safe}</a></p>
<p style="color:#888">If you didn't sign up, you can ignore this email.</p>`,
  };
}

export function passwordResetEmailBody(url: string): { html: string; text: string } {
  const safe = escape(url);
  return {
    text: `Reset your Superlog password.\n\n${url}\n\nThis link expires in 1 hour. If you didn't request a reset, ignore this email.`,
    html: `<p>Reset your Superlog password.</p>
<p><a href="${safe}">${safe}</a></p>
<p style="color:#888">This link expires in 1 hour. If you didn't request a reset, ignore this email.</p>`,
  };
}

export function orgInvitationEmailBody(args: {
  url: string;
  orgName: string;
  inviterEmail: string;
  inviterName?: string | null;
  role: string;
}): { html: string; text: string } {
  const safe = escape(args.url);
  const org = escape(args.orgName);
  const inviter = escape(args.inviterName?.trim() ? args.inviterName : args.inviterEmail);
  const role = escape(args.role);
  return {
    text: `${args.inviterName?.trim() || args.inviterEmail} invited you to join ${args.orgName} on Superlog as ${args.role}.\n\nAccept: ${args.url}\n\nIf you weren't expecting this invite, you can ignore it.`,
    html: `<p>${inviter} invited you to join <strong>${org}</strong> on Superlog as ${role}.</p>
<p><a href="${safe}">Accept invitation</a></p>
<p style="color:#888">If you weren't expecting this invite, you can ignore it.</p>`,
  };
}
