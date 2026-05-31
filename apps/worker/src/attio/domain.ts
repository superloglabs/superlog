export type OrgSnapshot = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
  ownerEmail: string | null;
  memberEmails: string[];
  githubConnected: boolean;
  slackConnected: boolean;
  mcpConnected: boolean;
  prsOpenedLastWeek: number;
  prsMergedLastWeek: number;
  projectIds: string[];
};

export type UserOrgMembership = {
  orgId: string;
  orgName: string;
  role: string;
};

export type UserSnapshot = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  memberships: UserOrgMembership[];
};

export type OrgTraceMetrics = {
  tracesLastWeek: number;
  spanRowsLastWeek: number;
};

export type AttioValues = Record<string, unknown>;

export type CompanyWrite = {
  object: "companies";
  recordId?: string;
  orgId: string;
  values: AttioValues;
};

export type PersonUpsert = {
  object: "people";
  matchingAttribute: "email_addresses";
  email: string;
  userId: string;
  values: AttioValues;
};

export type CompanyTeamUpdate = {
  object: "companies";
  recordId: string;
  orgId: string;
  memberEmails: string[];
};

export type AttioSyncPlan = {
  companyUpdates: Required<CompanyWrite>[];
  companyCreates: CompanyWrite[];
  peopleUpserts: PersonUpsert[];
  companyTeamUpdates: CompanyTeamUpdate[];
  totals: {
    orgs: number;
    companyUpdates: number;
    companyCreates: number;
    peopleUpserts: number;
    companyTeamUpdates: number;
    memberships: number;
    unambiguousTeamMemberships: number;
    githubConnected: number;
    slackConnected: number;
    withTracesLastWeek: number;
    prsOpenedLastWeek: number;
    prsMergedLastWeek: number;
    mcpConnectedAuditOnly: number;
  };
};

export function buildCompanyDescription(org: OrgSnapshot): string {
  const parts = [
    `Superlog org slug: ${org.slug}`,
    `Created: ${org.createdAt}`,
    `Members: ${org.memberCount}`,
    `Projects: ${org.projectCount}`,
  ];
  if (org.ownerEmail) parts.push(`Owner: ${org.ownerEmail}`);
  return parts.join("\n");
}

export function buildCompanyAnalyticsValues(
  org: OrgSnapshot,
  traceMetrics: OrgTraceMetrics = { tracesLastWeek: 0, spanRowsLastWeek: 0 },
): AttioValues {
  return {
    superlog_org_id: org.id,
    superlog_org_name: org.name,
    github_connected: org.githubConnected,
    slack_connected: org.slackConnected,
    traces_last_week: traceMetrics.tracesLastWeek,
    prs_opened_last_week: String(org.prsOpenedLastWeek),
    prs_merged_last_week: org.prsMergedLastWeek,
  };
}

export function buildPersonName(name: string | null | undefined, email: string) {
  const fullName = String(name ?? "").trim() || email.split("@")[0] || email;
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] ?? fullName,
    last_name: parts.length > 1 ? parts.slice(1).join(" ") : "",
    full_name: fullName,
  };
}

export function buildPersonDescription(user: UserSnapshot): string {
  const lines = [`Superlog user ID: ${user.id}`, `Created: ${user.createdAt}`];
  if (user.memberships.length > 0) {
    lines.push("Org memberships:");
    for (const membership of user.memberships) {
      lines.push(`- ${membership.orgName} (${membership.role}) [${membership.orgId}]`);
    }
  }
  return lines.join("\n");
}

export function buildAttioSyncPlan(input: {
  orgs: OrgSnapshot[];
  users: UserSnapshot[];
  companyRecordsByOrgId: Map<string, string>;
  tracesByOrgId: Map<string, OrgTraceMetrics>;
}): AttioSyncPlan {
  const companyUpdates: Required<CompanyWrite>[] = [];
  const companyCreates: CompanyWrite[] = [];
  const companyRecordIdByOrgId = new Map(input.companyRecordsByOrgId);

  for (const org of input.orgs) {
    const analytics = buildCompanyAnalyticsValues(org, input.tracesByOrgId.get(org.id));
    const recordId = companyRecordIdByOrgId.get(org.id);
    if (recordId) {
      companyUpdates.push({
        object: "companies",
        recordId,
        orgId: org.id,
        values: analytics,
      });
    } else {
      companyCreates.push({
        object: "companies",
        orgId: org.id,
        values: {
          name: org.name || org.slug || org.id,
          description: buildCompanyDescription(org),
          ...analytics,
        },
      });
    }
  }

  const peopleUpserts = input.users.map((user) => {
    const email = user.email.toLowerCase();
    return {
      object: "people" as const,
      matchingAttribute: "email_addresses" as const,
      email,
      userId: user.id,
      values: {
        email_addresses: [email],
        name: buildPersonName(user.name, email),
        description: buildPersonDescription(user),
      },
    };
  });

  const mappedOrgIds = new Set([
    ...companyRecordIdByOrgId.keys(),
    ...companyCreates.map((company) => company.orgId),
  ]);
  const mappedMembershipCountByEmail = new Map<string, number>();
  for (const user of input.users) {
    const email = user.email.toLowerCase();
    const count = user.memberships.filter((membership) =>
      mappedOrgIds.has(membership.orgId),
    ).length;
    mappedMembershipCountByEmail.set(email, count);
  }

  const teamEmailsByOrgId = new Map<string, Set<string>>();
  for (const user of input.users) {
    const email = user.email.toLowerCase();
    if (mappedMembershipCountByEmail.get(email) !== 1) continue;
    for (const membership of user.memberships) {
      if (!mappedOrgIds.has(membership.orgId)) continue;
      const emails = teamEmailsByOrgId.get(membership.orgId) ?? new Set<string>();
      emails.add(email);
      teamEmailsByOrgId.set(membership.orgId, emails);
    }
  }

  const companyTeamUpdates: CompanyTeamUpdate[] = [];
  for (const org of input.orgs) {
    const recordId = companyRecordIdByOrgId.get(org.id);
    if (!recordId) continue;
    const memberEmails = [...(teamEmailsByOrgId.get(org.id) ?? new Set<string>())].sort();
    companyTeamUpdates.push({ object: "companies", recordId, orgId: org.id, memberEmails });
  }

  return {
    companyUpdates,
    companyCreates,
    peopleUpserts,
    companyTeamUpdates,
    totals: {
      orgs: input.orgs.length,
      companyUpdates: companyUpdates.length,
      companyCreates: companyCreates.length,
      peopleUpserts: peopleUpserts.length,
      companyTeamUpdates: companyTeamUpdates.length,
      memberships: input.users.reduce((sum, user) => sum + user.memberships.length, 0),
      unambiguousTeamMemberships: companyTeamUpdates.reduce(
        (sum, update) => sum + update.memberEmails.length,
        0,
      ),
      githubConnected: input.orgs.filter((org) => org.githubConnected).length,
      slackConnected: input.orgs.filter((org) => org.slackConnected).length,
      withTracesLastWeek: input.orgs.filter(
        (org) => (input.tracesByOrgId.get(org.id)?.tracesLastWeek ?? 0) > 0,
      ).length,
      prsOpenedLastWeek: input.orgs.reduce((sum, org) => sum + org.prsOpenedLastWeek, 0),
      prsMergedLastWeek: input.orgs.reduce((sum, org) => sum + org.prsMergedLastWeek, 0),
      mcpConnectedAuditOnly: input.orgs.filter((org) => org.mcpConnected).length,
    },
  };
}
