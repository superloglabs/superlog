// Import step of the Clerk → Better Auth migration. Plays back the JSON
// produced by scripts/clerk-migration/export.ts into our local Postgres.
//
// Idempotent: re-running upserts on (clerk_id) for users and (clerk_org_id)
// for orgs, and on (org_id, user_id) for memberships. Safe to dry-run with
// `--dry-run` first to print the diff.
//
// Usage:
//   DATABASE_URL=postgres://... pnpm tsx scripts/clerk-migration/import.ts \
//     --in tmp/clerk-export.json [--dry-run]

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { db, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";

// Local replacement for nanoid — pnpm + node 25 sometimes fails to resolve
// the bare `nanoid` package from scripts that aren't part of a workspace
// package. We only need a short collision-resistant suffix for slug
// disambiguation; crypto.randomBytes is more than sufficient.
function shortId(len: number): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

type ExportedUser = {
  clerkId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  createdAt: string;
};

type ExportedOrg = {
  clerkOrgId: string;
  name: string;
  slug: string | null;
  createdAt: string;
};

type ExportedMembership = {
  clerkOrgId: string;
  clerkUserId: string;
  role: string;
  createdAt: string;
};

type Export = {
  exportedAt: string;
  users: ExportedUser[];
  orgs: ExportedOrg[];
  memberships: ExportedMembership[];
};

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `org-${nanoid(6).toLowerCase()}`;
}

async function uniqueOrgSlug(base: string): Promise<string> {
  let candidate = base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = await db.query.orgs.findFirst({ where: eq(schema.orgs.slug, candidate) });
    if (!existing) return candidate;
    candidate = `${base.slice(0, 32)}-${nanoid(6).toLowerCase()}`;
  }
  return `${base.slice(0, 20)}-${nanoid(12).toLowerCase()}`;
}

function toLocalRole(clerkRole: string): "owner" | "member" {
  return clerkRole.includes("admin") || clerkRole.includes("owner") ? "owner" : "member";
}

function parseArgs(): { inPath: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let inPath = "tmp/clerk-export.json";
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--in" && args[i + 1]) {
      inPath = args[i + 1] as string;
      i += 1;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }
  return { inPath, dryRun };
}

async function main() {
  const { inPath, dryRun } = parseArgs();
  const raw = await readFile(inPath, "utf8");
  const payload = JSON.parse(raw) as Export;

  process.stderr.write(
    `Loaded ${inPath}: ${payload.users.length} users, ${payload.orgs.length} orgs, ${payload.memberships.length} memberships\n`,
  );

  // --- Users: upsert on clerk_id, fall back to email match for rows the
  // lazy-sync may have created with email but without clerk_id. ---
  let usersCreated = 0;
  let usersUpdated = 0;
  const userIdByClerkId = new Map<string, string>();
  for (const u of payload.users) {
    const byClerkId = await db.query.users.findFirst({
      where: eq(schema.users.clerkId, u.clerkId),
    });
    if (byClerkId) {
      if (!dryRun) {
        await db
          .update(schema.users)
          .set({
            email: u.email,
            name: u.name,
            emailVerified: u.emailVerified,
            image: u.image,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, byClerkId.id));
      }
      userIdByClerkId.set(u.clerkId, byClerkId.id);
      usersUpdated += 1;
      continue;
    }
    const byEmail = await db.query.users.findFirst({ where: eq(schema.users.email, u.email) });
    if (byEmail) {
      if (!dryRun) {
        await db
          .update(schema.users)
          .set({
            clerkId: u.clerkId,
            name: u.name,
            emailVerified: u.emailVerified,
            image: u.image,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, byEmail.id));
      }
      userIdByClerkId.set(u.clerkId, byEmail.id);
      usersUpdated += 1;
      continue;
    }
    if (!dryRun) {
      const inserted = await db
        .insert(schema.users)
        .values({
          email: u.email,
          name: u.name,
          emailVerified: u.emailVerified,
          image: u.image,
          clerkId: u.clerkId,
          createdAt: new Date(u.createdAt),
        })
        .returning({ id: schema.users.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error(`failed to insert user ${u.clerkId}`);
      userIdByClerkId.set(u.clerkId, id);
    }
    usersCreated += 1;
  }
  process.stderr.write(`  users: ${usersCreated} created, ${usersUpdated} updated\n`);

  // --- Orgs: upsert on clerk_org_id, fall back to slug match for orgs the
  // lazy-sync may have created. ---
  let orgsCreated = 0;
  let orgsUpdated = 0;
  const orgIdByClerkOrgId = new Map<string, string>();
  for (const o of payload.orgs) {
    const byClerkOrgId = await db.query.orgs.findFirst({
      where: eq(schema.orgs.clerkOrgId, o.clerkOrgId),
    });
    if (byClerkOrgId) {
      if (!dryRun) {
        await db
          .update(schema.orgs)
          .set({ name: o.name, updatedAt: new Date() })
          .where(eq(schema.orgs.id, byClerkOrgId.id));
      }
      orgIdByClerkOrgId.set(o.clerkOrgId, byClerkOrgId.id);
      orgsUpdated += 1;
      continue;
    }
    const bySlug = o.slug
      ? await db.query.orgs.findFirst({
          where: and(eq(schema.orgs.slug, o.slug), isNull(schema.orgs.clerkOrgId)),
        })
      : null;
    if (bySlug) {
      if (!dryRun) {
        await db
          .update(schema.orgs)
          .set({ name: o.name, clerkOrgId: o.clerkOrgId, updatedAt: new Date() })
          .where(eq(schema.orgs.id, bySlug.id));
      }
      orgIdByClerkOrgId.set(o.clerkOrgId, bySlug.id);
      orgsUpdated += 1;
      continue;
    }
    if (!dryRun) {
      const slug = await uniqueOrgSlug(o.slug ?? slugify(o.name));
      const inserted = await db
        .insert(schema.orgs)
        .values({
          name: o.name,
          slug,
          clerkOrgId: o.clerkOrgId,
          createdAt: new Date(o.createdAt),
        })
        .returning({ id: schema.orgs.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error(`failed to insert org ${o.clerkOrgId}`);
      orgIdByClerkOrgId.set(o.clerkOrgId, id);

      // Bootstrap a Default project so the org isn't trapped on the
      // OnboardingGate after sign-in.
      const project = await db
        .insert(schema.projects)
        .values({ orgId: id, name: "Default", slug: "default" })
        .returning({ id: schema.projects.id });
      const projectId = project[0]?.id;
      if (projectId) {
        await db
          .insert(schema.projectAutomationSettings)
          .values({ projectId })
          .onConflictDoNothing({ target: schema.projectAutomationSettings.projectId });
      }
    }
    orgsCreated += 1;
  }
  process.stderr.write(`  orgs: ${orgsCreated} created, ${orgsUpdated} updated\n`);

  // --- Memberships: upsert on (org_id, user_id). ---
  let membershipsCreated = 0;
  let membershipsUpdated = 0;
  let membershipsSkipped = 0;
  for (const m of payload.memberships) {
    const userId = userIdByClerkId.get(m.clerkUserId);
    const orgId = orgIdByClerkOrgId.get(m.clerkOrgId);
    if (!userId || !orgId) {
      membershipsSkipped += 1;
      continue;
    }
    const existing = await db.query.orgMembers.findFirst({
      where: and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId)),
    });
    const role = toLocalRole(m.role);
    if (existing) {
      if (!dryRun && existing.role !== role) {
        await db
          .update(schema.orgMembers)
          .set({ role })
          .where(eq(schema.orgMembers.id, existing.id));
      }
      membershipsUpdated += 1;
      continue;
    }
    if (!dryRun) {
      await db.insert(schema.orgMembers).values({
        orgId,
        userId,
        role,
        createdAt: new Date(m.createdAt),
      });
    }
    membershipsCreated += 1;
  }
  process.stderr.write(
    `  memberships: ${membershipsCreated} created, ${membershipsUpdated} updated, ${membershipsSkipped} skipped (missing user or org)\n`,
  );

  if (dryRun) {
    process.stderr.write("Dry run — no rows were written.\n");
  } else {
    process.stderr.write("Done.\n");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
