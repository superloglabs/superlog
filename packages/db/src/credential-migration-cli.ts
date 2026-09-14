import { closeDb } from "./client.js";
import {
  backfillCredentialStorage,
  eraseLegacyPlaintextCredentials,
  inspectCredentialStorage,
} from "./credential-migration.js";

async function main(): Promise<void> {
  const backfill = process.argv.includes("--backfill");
  const erase = process.argv.includes("--erase-plaintext");
  if (backfill) await backfillCredentialStorage();
  if (erase) await eraseLegacyPlaintextCredentials();
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
