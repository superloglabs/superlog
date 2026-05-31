// Registers a Linear webhook for every active linear_installations row that
// doesn't already have one.
//
// Why:
//   The OAuth callback (apps/api/src/linear.ts) now registers a webhook at
//   install time so we can ingest Issue/Comment events into agent_pr_events.
//   Existing installs from before that change have no webhook.
//
// What it does:
//   - Lists active (revoked_at IS NULL) linear_installations with webhook_id IS NULL.
//   - Refreshes the access token if needed (ensureFreshLinearToken).
//   - Calls Linear's webhookCreate mutation for resourceTypes ["Issue", "Comment"]
//     pointed at ${API_BASE_URL}/linear/webhook.
//   - Persists webhook_id + webhook_secret on the row.
//
// Required env:
//   DATABASE_URL, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, API_BASE_URL
//
// API_BASE_URL must be a public URL Linear can reach. The script refuses to
// run against localhost / 127.0.0.1.
//
// Run:
//   pnpm tsx scripts/backfill-linear-webhooks.ts --dry-run
//   pnpm tsx scripts/backfill-linear-webhooks.ts --apply

import process from "node:process";
import { and, eq, isNull } from "drizzle-orm";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are required");
  }
  const apiBaseRaw = process.env.API_BASE_URL;
  if (!apiBaseRaw) throw new Error("API_BASE_URL is required");
  const apiBase = apiBaseRaw.replace(/\/$/, "");
  if (apiBase.includes("localhost") || apiBase.includes("127.0.0.1")) {
    throw new Error(
      `API_BASE_URL points at localhost (${apiBase}); Linear cannot reach it. Aborting.`,
    );
  }
  const webhookUrl = `${apiBase}/linear/webhook`;

  const apply = process.argv.includes("--apply");
  const dry = process.argv.includes("--dry-run") || !apply;

  const [{ db }, schema, linear] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
    import("../packages/db/src/linear.js"),
  ]);

  const rows = await db.query.linearInstallations.findMany({
    where: and(
      isNull(schema.linearInstallations.revokedAt),
      isNull(schema.linearInstallations.webhookId),
    ),
  });

  console.log(
    `${dry ? "DRY RUN" : "APPLY"}: found ${rows.length} install(s) needing a webhook. URL: ${webhookUrl}`,
  );

  let registered = 0;
  let failed = 0;
  for (const row of rows) {
    const label = `${row.workspaceName ?? row.workspaceId} (org=${row.orgId.slice(0, 8)})`;
    if (dry) {
      console.log(`  would register webhook for ${label}`);
      continue;
    }

    try {
      const fresh = await linear.ensureFreshLinearToken({
        installationId: row.id,
        clientId,
        clientSecret,
      });
      const webhook = await linear.createLinearWebhook({
        accessToken: fresh.accessToken,
        url: webhookUrl,
        resourceTypes: ["Issue", "Comment"],
        label: "Superlog",
      });
      await db
        .update(schema.linearInstallations)
        .set({
          webhookId: webhook.id,
          webhookSecret: webhook.secret,
          updatedAt: new Date(),
        })
        .where(eq(schema.linearInstallations.id, row.id));
      console.log(`  ✓ ${label} → webhook ${webhook.id}`);
      registered += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${label}: ${msg}`);
      failed += 1;
    }
  }

  if (!dry) {
    console.log(`\nDone. registered=${registered} failed=${failed}`);
  } else {
    console.log("\nRe-run with --apply to register webhooks.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
