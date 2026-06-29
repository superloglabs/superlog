// Regenerate src/billing/usage-email-shell.generated.ts from usage-email.mjml.
// Run: pnpm --filter @superlog/worker build:email
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const billing = fileURLToPath(new URL("../src/billing/", import.meta.url));
const tmp = `${billing}.usage-email.tmp.html`;

execFileSync("npx", ["-y", "mjml", `${billing}usage-email.mjml`, "-o", tmp], { stdio: "inherit" });
const html = readFileSync(tmp, "utf8");
rmSync(tmp);

writeFileSync(
  `${billing}usage-email-shell.generated.ts`,
  "// GENERATED from usage-email.mjml — do not edit by hand.\n" +
    "// Regenerate: pnpm --filter @superlog/worker build:email\n" +
    `export const USAGE_EMAIL_SHELL = ${JSON.stringify(html)};\n`,
);
console.log("wrote src/billing/usage-email-shell.generated.ts");
