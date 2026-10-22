import { closeDb, db } from "./client.js";
import {
  parseRewrapArgs,
  rewrapIntegrationSecrets,
  rewrapSucceeded,
} from "./integration-secret-rewrap.js";
import { integrationSecretKeyring } from "./integration-secrets.js";

// Usage: pnpm --filter @superlog/db credentials:rewrap [--dry-run] [--batch-size=N]
//
// Prints one JSON line per encrypted column and a final summary line so the
// output stays readable in line-oriented log viewers. Never prints plaintext or
// key material.
const MAX_FAILURE_LINES = 50;

async function main(): Promise<void> {
  const args = parseRewrapArgs(process.argv.slice(2));
  const keyring = integrationSecretKeyring();
  const report = await rewrapIntegrationSecrets(db, { ...args, keyring });

  for (const column of report.columns) console.log(JSON.stringify(column));
  for (const failure of report.failures.slice(0, MAX_FAILURE_LINES)) {
    console.log(JSON.stringify({ failure }));
  }
  if (report.failures.length > MAX_FAILURE_LINES) {
    console.log(JSON.stringify({ omittedFailures: report.failures.length - MAX_FAILURE_LINES }));
  }
  console.log(
    JSON.stringify({
      summary: {
        dryRun: report.dryRun,
        currentVersion: report.currentVersion,
        configuredVersions: report.configuredVersions,
        ...report.totals,
      },
    }),
  );

  if (!rewrapSucceeded(report)) {
    console.error(
      report.totals.failed > 0
        ? `${report.totals.failed} encrypted value(s) could not be re-encrypted`
        : `${report.totals.remaining} encrypted value(s) are still on an old key version; re-run the rewrap`,
    );
    process.exitCode = 1;
  }
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDb();
    process.exitCode = 1;
  });
