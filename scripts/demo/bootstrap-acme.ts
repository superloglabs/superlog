import process from "node:process";
import { and, eq, isNull } from "drizzle-orm";

type Options = {
  target: string;
  ownerEmail: string;
  ownerClerkId: string | null;
  orgName: string;
  orgSlug: string;
  projectName: string;
  projectSlug: string;
  keyName: string;
  help: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  DATABASE_URL=... pnpm demo:bootstrap:acme -- --owner-email demo@example.com [options]",
    "",
    "Options:",
    "  --target <local|prod>           Label the environment in output (default: local)",
    "  --owner-email <email>           Email for the owning user (required)",
    "  --owner-clerk-id <id>           Optional Clerk id for the owner",
    "  --org-name <name>               Default: Acme",
    "  --org-slug <slug>               Default: acme",
    "  --project-name <name>           Default: Storefront",
    "  --project-slug <slug>           Default: storefront",
    "  --key-name <name>               Default: acme-<target>-ingest",
    "  --help                          Show this message",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const parsed = new Map<string, string>();
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    parsed.set(arg.slice(2), next);
    i += 1;
  }

  const target = parsed.get("target") ?? "local";
  return {
    target,
    ownerEmail: parsed.get("owner-email") ?? "",
    ownerClerkId: parsed.get("owner-clerk-id") ?? null,
    orgName: parsed.get("org-name") ?? "Acme",
    orgSlug: parsed.get("org-slug") ?? "acme",
    projectName: parsed.get("project-name") ?? "Storefront",
    projectSlug: parsed.get("project-slug") ?? "storefront",
    keyName: parsed.get("key-name") ?? `acme-${target}-ingest`,
    help,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  if (!options.ownerEmail) {
    throw new Error("--owner-email is required");
  }

  const [{ db }, schema, keys, agentRuntime] = await Promise.all([
    import("../../packages/db/src/client.js"),
    import("../../packages/db/src/schema.js"),
    import("../../packages/db/src/keys.js"),
    import("../../packages/db/src/agent-runtime.js"),
  ]);

  const existingByClerk = options.ownerClerkId
    ? await db.query.users.findFirst({
        where: eq(schema.users.clerkId, options.ownerClerkId),
      })
    : null;
  const existingByEmail = await db.query.users.findFirst({
    where: eq(schema.users.email, options.ownerEmail),
  });

  let user = existingByClerk ?? existingByEmail ?? null;
  if (!user) {
    const inserted = await db
      .insert(schema.users)
      .values({
        email: options.ownerEmail,
        clerkId: options.ownerClerkId,
      })
      .returning();
    user = inserted[0] ?? null;
  } else if (!user.clerkId && options.ownerClerkId) {
    const updated = await db
      .update(schema.users)
      .set({ clerkId: options.ownerClerkId })
      .where(eq(schema.users.id, user.id))
      .returning();
    user = updated[0] ?? user;
  }
  if (!user) throw new Error("failed to provision owner user");

  const existingOrg = await db.query.orgs.findFirst({
    where: eq(schema.orgs.slug, options.orgSlug),
  });
  const org =
    existingOrg ??
    (
      await db
        .insert(schema.orgs)
        .values({
          name: options.orgName,
          slug: options.orgSlug,
        })
        .returning()
    )[0] ??
    null;
  if (!org) throw new Error("failed to provision org");
  if (org.name !== options.orgName) {
    await db.update(schema.orgs).set({ name: options.orgName }).where(eq(schema.orgs.id, org.id));
  }

  const existingMembership = await db.query.orgMembers.findFirst({
    where: and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)),
  });
  if (!existingMembership) {
    await db.insert(schema.orgMembers).values({
      orgId: org.id,
      userId: user.id,
      role: "owner",
    });
  } else if (existingMembership.role !== "owner") {
    await db
      .update(schema.orgMembers)
      .set({ role: "owner" })
      .where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)));
  }

  const existingProject = await db.query.projects.findFirst({
    where: and(eq(schema.projects.orgId, org.id), eq(schema.projects.slug, options.projectSlug)),
  });
  const project =
    existingProject ??
    (
      await db
        .insert(schema.projects)
        .values({
          orgId: org.id,
          name: options.projectName,
          slug: options.projectSlug,
        })
        .returning()
    )[0] ??
    null;
  if (!project) throw new Error("failed to provision project");
  if (project.name !== options.projectName) {
    await db
      .update(schema.projects)
      .set({ name: options.projectName })
      .where(eq(schema.projects.id, project.id));
  }

  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiKeys.projectId, project.id),
        eq(schema.apiKeys.name, options.keyName),
        isNull(schema.apiKeys.revokedAt),
      ),
    );

  const { plaintext, hash, prefix } = keys.generateApiKey();
  const apiKeyRows = await db
    .insert(schema.apiKeys)
    .values({
      projectId: project.id,
      name: options.keyName,
      keyHash: hash,
      keyPrefix: prefix,
    })
    .returning();
  const apiKey = apiKeyRows[0] ?? null;
  if (!apiKey) throw new Error("failed to create ingest api key");

  const automationRows = await db
    .insert(schema.projectAutomationSettings)
    .values({
      projectId: project.id,
      autoInvestigateIssuesEnabled: true,
      agentRunProvider: agentRuntime.DEFAULT_AGENT_RUN_PROVIDER,
      maxRuntimeMinutes: 90,
      maxHumanResumeCount: 3,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.projectAutomationSettings.projectId,
      set: {
        autoInvestigateIssuesEnabled: true,
        agentRunProvider: agentRuntime.DEFAULT_AGENT_RUN_PROVIDER,
        maxRuntimeMinutes: 90,
        maxHumanResumeCount: 3,
        updatedAt: new Date(),
      },
    })
    .returning();
  const automation = automationRows[0] ?? null;
  if (!automation) throw new Error("failed to enable project automation");

  console.log(
    JSON.stringify(
      {
        environment: options.target,
        owner: {
          userId: user.id,
          email: user.email,
          clerkId: user.clerkId,
        },
        org: {
          id: org.id,
          name: options.orgName,
          slug: options.orgSlug,
        },
        project: {
          id: project.id,
          name: options.projectName,
          slug: options.projectSlug,
        },
        ingestApiKey: {
          id: apiKey.id,
          name: apiKey.name,
          keyPrefix: apiKey.keyPrefix,
          plaintext,
        },
        automation: {
          enabled: automation.autoInvestigateIssuesEnabled,
          provider: automation.agentRunProvider,
          maxRuntimeMinutes: automation.maxRuntimeMinutes,
          maxHumanResumeCount: automation.maxHumanResumeCount,
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(usage());
  process.exit(1);
});
