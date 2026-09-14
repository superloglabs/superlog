import { closeDb } from "./client.js";
import {
  backfillCredentialStorage,
  eraseLegacyPlaintextCredentials,
  inspectCredentialStorage,
  parseCredentialMigrationOperation,
} from "./credential-migration.js";

async function main(): Promise<void> {
  const operation = parseCredentialMigrationOperation(process.argv.slice(2));
  if (operation === "backfill") await backfillCredentialStorage();
  if (operation === "erase-plaintext") await eraseLegacyPlaintextCredentials();
  const report = await inspectCredentialStorage();
  console.log(JSON.stringify(report, null, 2));
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDb();
    process.exitCode = 1;
  });
