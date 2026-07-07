import { randomInt } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  db,
  generateApiKey,
  generateCliSession,
  hashCliSession,
  listAccessibleGithubInstallsForProject,
  schema,
  syncLoopsContactForUserProject,
} from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { nanoid } from "nanoid";

import { auth } from "./auth.js";
import { logger } from "./logger.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "gateway" });

const UPSTREAM = "https://api.anthropic.com";
const HARD_CAP_PER_ORG = Number(process.env.SUPERLOG_HARD_CAP ?? 500);
const DEVICE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_DAYS = 60;

export type Principal = {
  sessionId: string;
  userId: string;
  orgId: string;
  userEmail: string;
  orgName: string;
};

// "cli" — MCP / `superlog init` style pairing. Goes through a GitHub-install
// gate in the activate page before releasing the CLI token to the poller.
// "skill" — agent skill (e.g. superlog-onboard) running in the user's terminal
// pairing for OTel ingest only. Skips the GitHub gate (the post-signup
// onboarding wizard handles GH + Slack). The poller only receives an ingest
// key, never a CLI session token, since the skill never calls /v1/* gateway
// routes.
type DeviceFlow = "cli" | "skill";

type Device = {
  deviceCode: string;
  userCode: string;
  flow: DeviceFlow;
  createdAt: number;
  // user_linked = sign-in done and account/key rows created. For "cli"
  // flow we hold here until the GitHub install step finishes; for "skill" we
  // transition straight to approved.
  status: "pending" | "user_linked" | "approved" | "expired";
  session?: {
    cliToken: string;
    ingestKey: string;
    orgId: string;
    projectId: string;
    userEmail: string;
    orgName: string;
  };
};

const usageByOrg = new Map<string, number>();
const devicesByDeviceCode = new Map<string, Device>();
const devicesByUserCode = new Map<string, Device>();

export function getLinkedDevice(userCode: string): { orgId: string; projectId: string } | null {
  const device = devicesByUserCode.get(userCode.toUpperCase());
  if (!device || !device.session) return null;
  if (isExpired(device)) return null;
  if (device.status !== "user_linked") return null;
  return { orgId: device.session.orgId, projectId: device.session.projectId };
}

// Used by the post-pair integration redirects (GitHub install, Slack install)
// initiated from the skill. The skill device is already in `approved` state
// by the time it tries to drive these — getLinkedDevice rejects that.
// Accepts either user_linked or approved, but only for skill devices, since
// the cli/MCP flow has its own approval semantics that shouldn't be reused
// here.
export function getSkillDeviceForIntegration(
  userCode: string,
): { orgId: string; projectId: string } | null {
  const device = devicesByUserCode.get(userCode.toUpperCase());
  if (!device || !device.session) return null;
  if (device.flow !== "skill") return null;
  if (isExpired(device)) return null;
  if (device.status !== "user_linked" && device.status !== "approved") return null;
  return { orgId: device.session.orgId, projectId: device.session.projectId };
}

export function getDeviceFlow(userCode: string): DeviceFlow | null {
  const device = devicesByUserCode.get(userCode.toUpperCase());
  if (!device) return null;
  return device.flow;
}

export type GatewayVars = { principal: Principal };

// The host app's Variables type is invariant in Hono. We don't enforce it at
// the call site — callers should declare `principal?: Principal` in their own
// Vars if they want typed access downstream.
// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountGateway(app: Hono<any>, ch: ClickHouseClient): void {
  const upstreamKey = process.env.ANTHROPIC_API_KEY;
  if (!upstreamKey) {
    log.warn("ANTHROPIC_API_KEY not set — /v1/messages proxy disabled");
  }
  const publicUrl =
    process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4100}`;
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  app.post("/oauth/device", async (c) => {
    // Optional `flow` field — accept JSON body but tolerate empty/no body for
    // older callers (the MCP CLI flow doesn't send one).
    let flow: DeviceFlow = "cli";
    const ct = c.req.header("content-type") ?? "";
    if (ct.toLowerCase().includes("application/json")) {
      const body = (await c.req.json().catch(() => ({}))) as { flow?: unknown };
      if (body.flow === "skill") flow = "skill";
    } else {
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      if (form.flow === "skill") flow = "skill";
    }

    const deviceCode = `superlog_dev_${nanoid(24)}`;
    const userCode = humanCode();
    const device: Device = {
      deviceCode,
      userCode,
      flow,
      createdAt: Date.now(),
      status: "pending",
    };
    devicesByDeviceCode.set(deviceCode, device);
    devicesByUserCode.set(userCode, device);
    const verificationUri = new URL(`${webOrigin}/activate`);
    if (flow === "skill") verificationUri.searchParams.set("flow", "skill");
    const verificationUriComplete = new URL(verificationUri.toString());
    verificationUriComplete.searchParams.set("code", userCode);
    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri.toString(),
      verification_uri_complete: verificationUriComplete.toString(),
      expires_in: Math.floor(DEVICE_TTL_MS / 1000),
      interval: 2,
    });
  });

  app.post("/oauth/token", async (c, next) => {
    // The MCP OAuth flow registers its own /oauth/token at this path with
    // RFC 6749 form-encoded grants (authorization_code, refresh_token).
    // CLI device-flow requests come in as JSON with a device_code field —
    // anything else falls through to the MCP handler.
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("application/json")) {
      return next();
    }
    const body = (await c.req.json().catch(() => ({}))) as { device_code?: string };
    if (!body.device_code) return next();
    const device = devicesByDeviceCode.get(body.device_code);
    if (!device) return c.json({ error: "invalid_grant" }, 400);
    if (isExpired(device)) {
      device.status = "expired";
      log.warn(
        {
          user_code: device.userCode,
          flow: device.flow,
          age_ms: Date.now() - device.createdAt,
        },
        "device flow token expired (oauth/token)",
      );
      return c.json({ error: "expired_token" }, 410);
    }
    if (device.status !== "approved" || !device.session) {
      return c.json({ error: "authorization_pending" }, 428);
    }
    if (device.flow === "skill") {
      // Skill pollers only need the ingest key for OTel exporters; never
      // expose the gateway-scope CLI session token.
      // Refresh the device's createdAt so the post-pair integration URLs
      // (`/github/install?user_code=…`, `/slack/install?user_code=…`) the
      // skill is about to drive don't tip over the 10-min device TTL while
      // the user clicks through GitHub + Slack OAuth.
      device.createdAt = Date.now();
      return c.json({
        ingest_key: device.session.ingestKey,
        project_id: device.session.projectId,
        user: device.session.userEmail,
        org: device.session.orgName,
        user_code: device.userCode,
        flow: "skill",
      });
    }
    return c.json({
      access_token: device.session.cliToken,
      token_type: "Bearer",
      ingest_key: device.session.ingestKey,
      project_id: device.session.projectId,
      user: device.session.userEmail,
      org: device.session.orgName,
      gateway_url: publicUrl,
    });
  });

  app.get("/activate", (c) => {
    const code = c.req.query("code") ?? "";
    const url = new URL(`${webOrigin}/activate`);
    if (code) url.searchParams.set("code", code);
    return c.redirect(url.toString(), 302);
  });

  app.post("/activate/approve", async (c) => {
    const userId = await requireUserFromSession(c);
    if (userId instanceof Response) return userId;

    const body = (await c.req.json().catch(() => ({}))) as {
      user_code?: string;
      org_id?: string;
      project_id?: string;
    };
    const userCode = body.user_code?.toUpperCase() ?? "";
    const device = devicesByUserCode.get(userCode);
    if (!device) return c.json({ error: "unknown device code" }, 404);
    if (isExpired(device)) {
      device.status = "expired";
      log.warn(
        {
          user_code: userCode,
          user_id: userId,
          flow: device.flow,
          age_ms: Date.now() - device.createdAt,
        },
        "device code expired (activate/approve)",
      );
      return c.json({ error: "device code expired" }, 410);
    }
    if (device.status === "approved" || device.status === "user_linked") {
      return c.json({ error: "already approved" }, 409);
    }

    const { user, org, project } = await ensureAccount(userId, {
      orgId: body.org_id ?? null,
      projectId: body.project_id ?? null,
    });

    const cli = generateCliSession();
    const ingest = generateApiKey();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

    await db.transaction(async (tx) => {
      await tx.insert(schema.cliSessions).values({
        userId: user.id,
        orgId: org.id,
        tokenPrefix: cli.prefix,
        tokenHash: cli.hash,
        expiresAt,
      });
      await tx.insert(schema.apiKeys).values({
        projectId: project.id,
        name: "CLI-issued ingest key",
        keyPrefix: ingest.prefix,
        keyHash: ingest.hash,
      });
    });

    device.status = "user_linked";
    device.session = {
      cliToken: cli.plaintext,
      ingestKey: ingest.plaintext,
      orgId: org.id,
      projectId: project.id,
      userEmail: user.email,
      orgName: org.name,
    };
    void syncLoopsContactForUserProject({
      userId: user.id,
      projectId: project.id,
      appUrl: webOrigin,
    }).catch((err) =>
      log.warn({ err, user_id: user.id }, "loops contact sync failed after activation"),
    );

    // Skill flow has no GitHub gate — the post-signup OnboardingWizard prompts
    // for GitHub + Slack once the user lands on the dashboard. Approve in one
    // hop so the skill's poller can pick up the ingest key immediately.
    if (device.flow === "skill") {
      device.status = "approved";
      return c.json({
        ok: true,
        orgId: org.id,
        projectId: project.id,
        flow: "skill",
        ingestKey: ingest.plaintext,
        githubSetupNeeded: false,
      });
    }

    const accessibleInstalls = await listAccessibleGithubInstallsForProject(project.id);
    const githubSetupNeeded = accessibleInstalls.length === 0 && !org.githubSetupSkippedAt;

    return c.json({ ok: true, orgId: org.id, flow: "cli", githubSetupNeeded });
  });

  app.post("/activate/finalize", async (c) => {
    const userId = await requireUserFromSession(c);
    if (userId instanceof Response) return userId;
    void userId;

    const body = (await c.req.json().catch(() => ({}))) as { user_code?: string };
    const userCode = body.user_code?.toUpperCase() ?? "";
    const device = devicesByUserCode.get(userCode);
    if (!device) return c.json({ error: "unknown device code" }, 404);
    if (isExpired(device)) {
      device.status = "expired";
      log.warn(
        {
          user_code: userCode,
          flow: device.flow,
          age_ms: Date.now() - device.createdAt,
        },
        "device code expired (activate/finalize)",
      );
      return c.json({ error: "device code expired" }, 410);
    }
    if (device.status === "approved") return c.json({ ok: true });
    if (device.status !== "user_linked" || !device.session) {
      return c.json({ error: "not ready to finalize" }, 409);
    }

    device.status = "approved";
    return c.json({ ok: true });
  });

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization");
    if (!header?.toLowerCase().startsWith("bearer ")) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    const token = header.slice(7).trim();
    if (!token.startsWith("superlog_cli_")) {
      return c.json(
        {
          error:
            "wrong credential type: /v1/* requires a CLI session token (superlog_cli_*); did you mean to call intake.superlog.sh with your ingest key?",
        },
        401,
      );
    }
    const hash = hashCliSession(token);
    const session = await db.query.cliSessions.findFirst({
      where: eq(schema.cliSessions.tokenHash, hash),
    });
    if (!session || session.revokedAt) return c.json({ error: "invalid token" }, 401);
    if (session.expiresAt && session.expiresAt < new Date()) {
      return c.json({ error: "session expired" }, 401);
    }

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, session.userId),
    });
    const org = await db.query.orgs.findFirst({
      where: eq(schema.orgs.id, session.orgId),
    });
    if (!user || !org) return c.json({ error: "session references missing account" }, 401);

    c.set("principal", {
      sessionId: session.id,
      userId: session.userId,
      orgId: session.orgId,
      userEmail: user.email,
      orgName: org.name,
    });

    void db
      .update(schema.cliSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.cliSessions.id, session.id))
      .catch((err: unknown) => log.error({ err }, "failed to bump last_used_at"));

    await next();
  });

  app.get("/v1/me", (c) => {
    const p = c.var.principal as Principal;
    return c.json({
      user: p.userEmail,
      org: p.orgName,
      usage: usageByOrg.get(p.orgId) ?? 0,
      cap: HARD_CAP_PER_ORG,
    });
  });

  app.all("/v1/messages", async (c) => {
    if (!upstreamKey) {
      return c.json({ error: "gateway upstream not configured" }, 503);
    }
    const p = c.var.principal as Principal;
    const used = usageByOrg.get(p.orgId) ?? 0;
    if (used >= HARD_CAP_PER_ORG) {
      return c.json(
        {
          error: {
            type: "rate_limit_error",
            message: `org cap reached (${HARD_CAP_PER_ORG})`,
          },
        },
        429,
      );
    }
    usageByOrg.set(p.orgId, used + 1);
    log.info(
      { user: p.userEmail, org: p.orgName, used: used + 1, cap: HARD_CAP_PER_ORG },
      "/v1/messages",
    );
    return proxyToAnthropic(c.req.raw, "/v1/messages", upstreamKey);
  });

  app.get("/v1/telemetry/recent", async (c) => {
    const p = c.var.principal as Principal;
    const service = c.req.query("service");
    const since = c.req.query("since");
    if (!service || !since) {
      return c.json({ error: "service and since query params required" }, 400);
    }

    // The install-verify step only cares about the signed-in user's default
    // project. Multi-project users would query by project_id explicitly; that
    // case can wait until we actually have it.
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.orgId, p.orgId),
    });
    if (!project) return c.json({ error: "no project for this org" }, 404);

    const [traces, logs, metrics] = await Promise.all([
      chCountTraces(ch, project.id, service, since),
      chCountLogs(ch, project.id, service, since),
      chMetricsCountAcrossTables(ch, project.id, service, since),
    ]);

    return c.json({
      service,
      since,
      projectId: project.id,
      traces,
      logs,
      metrics,
    });
  });

  app.all("/v1/*", (c) => {
    if (!upstreamKey) {
      return c.json({ error: "gateway upstream not configured" }, 503);
    }
    return proxyToAnthropic(c.req.raw, new URL(c.req.url).pathname, upstreamKey);
  });
}

async function chCountTraces(
  ch: ClickHouseClient,
  projectId: string,
  service: string,
  since: string,
): Promise<{ count: number; firstAt?: string; firstSpanName?: string }> {
  const r = await ch.query({
    query: `
      SELECT count() AS c,
             toString(min(Timestamp)) AS first_at,
             argMin(SpanName, Timestamp) AS first_span
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND ServiceName = {service:String}
        AND Timestamp >= parseDateTime64BestEffortOrZero({since:String})
    `,
    query_params: { projectId, service, since },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { c: string | number; first_at?: string; first_span?: string }[];
  const row = rows[0];
  const count = Number(row?.c ?? 0);
  return {
    count,
    firstAt: count > 0 ? row?.first_at : undefined,
    firstSpanName: count > 0 ? row?.first_span : undefined,
  };
}

async function chCountLogs(
  ch: ClickHouseClient,
  projectId: string,
  service: string,
  since: string,
): Promise<{ count: number }> {
  const r = await ch.query({
    query: `
      SELECT count() AS c
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND ServiceName = {service:String}
        AND Timestamp >= parseDateTime64BestEffortOrZero({since:String})
    `,
    query_params: { projectId, service, since },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { c: string | number }[];
  return { count: Number(rows[0]?.c ?? 0) };
}

async function chMetricsCountAcrossTables(
  ch: ClickHouseClient,
  projectId: string,
  service: string,
  since: string,
): Promise<{ count: number }> {
  const tables = [
    "otel_metrics_gauge",
    "otel_metrics_sum",
    "otel_metrics_histogram",
    "otel_metrics_summary",
    "otel_metrics_exp_histogram",
  ];
  const counts = await Promise.all(
    tables.map(async (t) => {
      const r = await ch.query({
        query: `
          SELECT count() AS c
          FROM ${t}
          WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
            AND ServiceName = {service:String}
            AND TimeUnix >= parseDateTime64BestEffortOrZero({since:String})
        `,
        query_params: { projectId, service, since },
        format: "JSONEachRow",
      });
      const rows = (await r.json()) as { c: string | number }[];
      return Number(rows[0]?.c ?? 0);
    }),
  );
  return { count: counts.reduce((a, b) => a + b, 0) };
}

async function ensureAccount(
  userId: string,
  scope: { orgId: string | null; projectId: string | null } = {
    orgId: null,
    projectId: null,
  },
): Promise<{ user: schema.User; org: schema.Org; project: schema.Project }> {
  const { user, org, project } = await resolveActiveOrgContext({
    userId,
    preferredOrgId: scope.orgId,
    preferredProjectId: scope.projectId,
  });
  return { user, org, project };
}

export async function proxyToAnthropic(
  req: Request,
  path: string,
  upstreamKey: string,
): Promise<Response> {
  const url = new URL(path, UPSTREAM);
  // Allowlist only headers Anthropic needs. Forwarding cf-* / x-forwarded-*
  // from our inbound (api.superlog.sh is orange-clouded) makes Anthropic's
  // own Cloudflare edge think the request has already traversed CF and
  // reject it with Error 1000 ("DNS points to prohibited IP").
  const FORWARD = new Set(["content-type", "accept", "accept-encoding"]);
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (FORWARD.has(lower) || lower.startsWith("anthropic-") || lower.startsWith("x-stainless-")) {
      headers.set(name, value);
    }
  }
  headers.set("x-api-key", upstreamKey);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body:
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : (req.body as ReadableStream | null),
    duplex: "half",
    redirect: "manual",
  } as RequestInit & { duplex: "half" });

  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

async function requireUserFromSession(
  // biome-ignore lint/suspicious/noExplicitAny: Hono Context generics vary across mount points.
  c: any,
): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  return session.user.id;
}

function humanCode(): string {
  // Use a CSPRNG: the user_code is the sole secret an approver checks, so a
  // predictable PRNG (Math.random) would let an attacker guess in-flight codes
  // and approve a victim's pending device. randomInt is unbiased over the range.
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const pick = () => alphabet[randomInt(alphabet.length)];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

function isExpired(d: Device): boolean {
  return Date.now() - d.createdAt > DEVICE_TTL_MS;
}
