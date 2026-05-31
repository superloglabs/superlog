# Clerk → Better Auth migration

Two scripts to move existing prod users + org memberships out of Clerk and into
our local tables. Run once at cutover; delete this directory afterwards.

## Plan

1. Tag the release that contains Phase A–D (Better Auth wired but old Clerk
   sign-in still works in the prior deploy).
2. **Brief read-only window** (a few minutes) so the export doesn't race new
   sign-ups: pause the Clerk-fronted deploy or put up a maintenance banner.
3. Export — pulls users / orgs / memberships from Clerk via the REST API.
4. Dry-run import — inspect the counts and any "skipped" rows.
5. Real import — upserts into our local Postgres.
6. Deploy the Better Auth release. Users sign in with email + new password
   (via "forgot password") or with Google / GitHub OAuth.

## Run

```bash
# 1. Export from Clerk
CLERK_SECRET_KEY=sk_live_... pnpm tsx scripts/clerk-migration/export.ts \
  --out tmp/clerk-export.json

# 2. Dry-run the import — prints counts but doesn't write
DATABASE_URL=$(railway variables --service Postgres --kv | grep DATABASE_PUBLIC_URL | cut -d= -f2-) \
  pnpm tsx scripts/clerk-migration/import.ts --in tmp/clerk-export.json --dry-run

# 3. Real import
DATABASE_URL=... pnpm tsx scripts/clerk-migration/import.ts --in tmp/clerk-export.json
```

## What gets written

- `users` rows: upsert on `clerk_id`. Falls back to `email` for rows the old
  lazy-sync created (those would have `clerk_id = null`). Sets `name`,
  `email_verified`, `image`, `updated_at`.
- `orgs` rows: upsert on `clerk_org_id`. Falls back to `slug` for orgs the
  old lazy-sync created. New orgs also get a `Default` project +
  `project_automation_settings` row so the user can land in the dashboard
  without hitting the OnboardingGate dead-end.
- `org_members` rows: upsert on `(org_id, user_id)`. Maps Clerk roles to our
  `owner` / `member` enum (anything with "admin" or "owner" becomes owner).

## What does NOT migrate

- **Passwords.** Clerk doesn't expose password hashes. Users sign in with
  a new password via "forgot password", or with Google / GitHub OAuth.
- **Active sessions.** All existing Clerk sessions are dropped at cutover.
- **External accounts (linked OAuth identities).** A user who signed in via
  Google in Clerk will re-link Google on their first Better Auth sign-in.

## Verification queries

```sql
-- Users with a clerk_id (came from this migration or earlier lazy-sync)
SELECT count(*) FROM users WHERE clerk_id IS NOT NULL;

-- Orgs with a clerk_org_id
SELECT count(*) FROM orgs WHERE clerk_org_id IS NOT NULL;

-- Memberships per org
SELECT o.name, count(*) AS members
FROM org_members m JOIN orgs o ON o.id = m.org_id
GROUP BY o.id, o.name ORDER BY members DESC;

-- Users who would be orphaned (no memberships) — should be zero post-import
SELECT u.email FROM users u
LEFT JOIN org_members m ON m.user_id = u.id
WHERE m.user_id IS NULL;
```

## Cleanup after cutover

Once the import is verified and users are signing in via Better Auth, drop
the legacy columns and delete this directory. See Phase F migration in
`packages/db/migrations/` for the column drop.
