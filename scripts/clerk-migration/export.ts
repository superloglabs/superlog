// Clerk export step of the Clerk → Better Auth migration.
//
// Talks to Clerk's REST API directly so we don't need to keep @clerk/backend
// installed past the migration. Dumps users, orgs, and memberships to a JSON
// file that scripts/clerk-migration/import.ts then plays back into our local
// Postgres.
//
// Usage:
//   CLERK_SECRET_KEY=sk_test_... pnpm tsx scripts/clerk-migration/export.ts \
//     --out tmp/clerk-export.json
//
// On success, prints summary counts to stderr and writes the export to the
// path you passed in --out (defaults to tmp/clerk-export.json).

import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const PAGE_LIMIT = 500;
const BASE = "https://api.clerk.com/v1";

type ClerkEmailAddress = {
  id: string;
  email_address: string;
  verification: { status: string } | null;
};

type ClerkUser = {
  id: string;
  primary_email_address_id: string | null;
  email_addresses: ClerkEmailAddress[];
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  created_at: number;
};

type ClerkOrg = {
  id: string;
  name: string;
  slug: string | null;
  created_at: number;
};

type ClerkMembership = {
  id: string;
  role: string;
  public_user_data: { user_id: string };
  created_at: number;
};

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

async function paginate<T>(path: string, secret: string): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  while (true) {
    const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Clerk ${path} failed ${res.status}: ${body}`);
    }
    const body = (await res.json()) as T[] | { data: T[] };
    const rows = Array.isArray(body) ? body : (body.data ?? []);
    out.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
    offset += rows.length;
  }
  return out;
}

function primaryEmail(user: ClerkUser): { email: string; verified: boolean } | null {
  const primary =
    user.email_addresses.find((e) => e.id === user.primary_email_address_id) ??
    user.email_addresses[0];
  if (!primary) return null;
  return {
    email: primary.email_address.toLowerCase(),
    verified: primary.verification?.status === "verified",
  };
}

function fullName(user: ClerkUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
}

function parseArgs(): { outPath: string } {
  const args = process.argv.slice(2);
  let outPath = "tmp/clerk-export.json";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out" && args[i + 1]) {
      outPath = args[i + 1] as string;
      i += 1;
    }
  }
  return { outPath };
}

async function main() {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    console.error("CLERK_SECRET_KEY is required");
    process.exit(1);
  }
  const { outPath } = parseArgs();

  process.stderr.write("Fetching users…\n");
  const clerkUsers = await paginate<ClerkUser>("/users", secret);
  process.stderr.write(`  ${clerkUsers.length} users\n`);

  process.stderr.write("Fetching organizations…\n");
  const clerkOrgs = await paginate<ClerkOrg>("/organizations", secret);
  process.stderr.write(`  ${clerkOrgs.length} orgs\n`);

  process.stderr.write("Fetching memberships per org…\n");
  const memberships: ExportedMembership[] = [];
  for (const org of clerkOrgs) {
    const rows = await paginate<ClerkMembership>(
      `/organizations/${org.id}/memberships`,
      secret,
    );
    for (const m of rows) {
      memberships.push({
        clerkOrgId: org.id,
        clerkUserId: m.public_user_data.user_id,
        role: m.role,
        createdAt: new Date(m.created_at).toISOString(),
      });
    }
  }
  process.stderr.write(`  ${memberships.length} memberships\n`);

  const users: ExportedUser[] = [];
  for (const u of clerkUsers) {
    const email = primaryEmail(u);
    if (!email) {
      process.stderr.write(`  skipping ${u.id} — no email\n`);
      continue;
    }
    users.push({
      clerkId: u.id,
      email: email.email,
      emailVerified: email.verified,
      name: fullName(u) || email.email.split("@")[0] || "",
      image: u.image_url,
      createdAt: new Date(u.created_at).toISOString(),
    });
  }

  const orgs: ExportedOrg[] = clerkOrgs.map((o) => ({
    clerkOrgId: o.id,
    name: o.name,
    slug: o.slug,
    createdAt: new Date(o.created_at).toISOString(),
  }));

  const payload: Export = {
    exportedAt: new Date().toISOString(),
    users,
    orgs,
    memberships,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  process.stderr.write(`Wrote ${outPath}\n`);
  process.stderr.write(
    `Summary: ${users.length} users, ${orgs.length} orgs, ${memberships.length} memberships\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
