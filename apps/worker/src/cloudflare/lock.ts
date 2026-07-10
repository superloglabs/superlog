import { sql } from "drizzle-orm";

// The per-installation advisory lock the Cloudflare jobs and the api's on-demand
// refresh all take before redeeming a refresh token. Cloudflare rotates the
// refresh token on every use and, under reuse detection, revokes the whole grant
// if the same token is redeemed twice — so every actor that might refresh a given
// installation must serialize on the SAME key. This is that single source of
// truth; it MUST stay identical to apps/api/src/cloudflare.ts freshAccessToken.
//
// `pg_advisory_xact_lock` auto-releases at transaction end, so callers must run
// inside a transaction and hold it only across the token redemption.
export function lockInstallation(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  installationId: string,
): Promise<unknown> {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('cloudflare_installations'), hashtext(${installationId}))`,
  );
}
