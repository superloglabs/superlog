// Dev-only: mints an mcp_oauth_clients + mcp_oauth_tokens row and prints the
// plaintext bearer to stdout. Used for end-to-end MCP smoke tests.
import { createHash, randomBytes } from "node:crypto";

const userId = process.argv[2];
const projectId = process.argv[3];
const resource = process.argv[4] ?? "http://localhost:4100/mcp";

if (!userId || !projectId) {
  console.error("usage: tsx mint-mcp-token.ts <userId> <projectId> [resource]");
  process.exit(1);
}

const [{ db }, schema] = await Promise.all([
  import("../packages/db/src/client.js"),
  import("../packages/db/src/schema.js"),
]);

const [client] = await db
  .insert(schema.mcpOauthClients)
  .values({
    name: "smoke-test",
    redirectUris: ["http://localhost/callback"],
    tokenEndpointAuthMethod: "none",
  })
  .returning();

const plaintext = `mcp_at_${randomBytes(32).toString("base64url")}`;
const accessHash = createHash("sha256").update(plaintext).digest("hex");

await db.insert(schema.mcpOauthTokens).values({
  accessHash,
  clientId: client.id,
  userId,
  projectId,
  resource,
  scope: null,
  accessExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
});

console.log(plaintext);
process.exit(0);
