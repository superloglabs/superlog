import { db } from "./client.js";
import { generateApiKey } from "./keys.js";
import { apiKeys } from "./schema.js";

export type MintedApiKey = {
  id: string;
  projectId: string;
  name: string;
  keyPrefix: string;
  plaintext: string;
  createdAt: Date;
};

export async function mintApiKey(args: {
  projectId: string;
  name: string;
}): Promise<MintedApiKey> {
  const { plaintext, hash, prefix } = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      projectId: args.projectId,
      name: args.name,
      keyHash: hash,
      keyPrefix: prefix,
    })
    .returning();
  if (!row) throw new Error("failed to mint api key");
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    plaintext,
    createdAt: row.createdAt,
  };
}
