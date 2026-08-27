export type SupabaseGrant = {
  id: string;
  orgId: string;
  revokedAt: Date | null;
};

export type SupabaseProject = {
  ref: string;
  name: string;
  organizationSlug: string;
  region: string;
};

export type SupabaseConnectionInput = {
  projectRef: string;
  projectName: string;
  organizationSlug: string;
  region: string;
  environment: string;
};

export type SupabaseConnectionView = SupabaseConnectionInput & { id: string };

export interface SupabaseConnectionRepository {
  findGrant(orgId: string, grantId: string): Promise<SupabaseGrant | null>;
  upsertConnections(input: {
    projectId: string;
    grantId: string;
    actorUserId: string;
    connections: SupabaseConnectionInput[];
  }): Promise<SupabaseConnectionView[]>;
}

export interface SupabaseGateway {
  listProjects(grantId: string): Promise<SupabaseProject[]>;
}

export interface SupabaseGrantRepository {
  upsertGrant(input: {
    orgId: string;
    actorUserId: string;
    supabaseUserId: string;
    primaryEmail: string;
    username: string;
    accessToken: string;
    refreshToken: string | null;
    tokenExpiresAt: Date;
  }): Promise<SupabaseGrant>;
}

export interface SupabaseOAuthGateway {
  exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresInSeconds: number;
  }>;
  getProfile(accessToken: string): Promise<{
    userId: string;
    primaryEmail: string;
    username: string;
  }>;
}

export async function completeSupabaseOAuth(input: {
  orgId: string;
  actorUserId: string;
  code: string;
  repository: SupabaseGrantRepository;
  gateway: SupabaseOAuthGateway;
  now?: Date;
}): Promise<SupabaseGrant> {
  const now = input.now ?? new Date();
  const token = await input.gateway.exchangeCode(input.code);
  const profile = await input.gateway.getProfile(token.accessToken);
  return input.repository.upsertGrant({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    supabaseUserId: profile.userId,
    primaryEmail: profile.primaryEmail,
    username: profile.username,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenExpiresAt: new Date(now.getTime() + token.expiresInSeconds * 1000),
  });
}

export async function connectSupabaseProjects(input: {
  orgId: string;
  projectId: string;
  grantId: string;
  actorUserId: string;
  selections: Array<{ projectRef: string; environment: string }>;
  repository: SupabaseConnectionRepository;
  gateway: SupabaseGateway;
}): Promise<SupabaseConnectionView[]> {
  if (input.selections.length === 0) throw new Error("select at least one Supabase project");
  if (input.selections.length > 100) throw new Error("select at most 100 Supabase projects");
  const refs = new Set<string>();
  for (const selection of input.selections) {
    if (
      !selection ||
      typeof selection.projectRef !== "string" ||
      typeof selection.environment !== "string"
    ) {
      throw new Error("each Supabase connection requires a project and environment");
    }
    if (refs.has(selection.projectRef)) throw new Error("duplicate Supabase project selection");
    refs.add(selection.projectRef);
  }
  const grant = await input.repository.findGrant(input.orgId, input.grantId);
  if (!grant || grant.revokedAt) throw new Error("Supabase grant not found");

  const projects = await input.gateway.listProjects(grant.id);
  const byRef = new Map(projects.map((project) => [project.ref, project]));
  const connections = input.selections.map((selection) => {
    const project = byRef.get(selection.projectRef);
    if (!project) throw new Error("Supabase project is not available to this grant");
    return {
      projectRef: project.ref,
      projectName: project.name,
      organizationSlug: project.organizationSlug,
      region: project.region,
      environment: parseEnvironment(selection.environment),
    };
  });

  return input.repository.upsertConnections({
    projectId: input.projectId,
    grantId: grant.id,
    actorUserId: input.actorUserId,
    connections,
  });
}

function parseEnvironment(value: string): string {
  const environment = value.trim();
  const hasControlCharacter = [...environment].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!environment || environment.length > 64 || hasControlCharacter) {
    throw new Error("environment must be between 1 and 64 printable characters");
  }
  return environment;
}
