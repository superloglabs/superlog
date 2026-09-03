import type {
  SupabaseProject as ManagementProject,
  SupabaseManagementClient,
  SupabaseOAuthConfig,
} from "@superlog/supabase";
import type { SupabaseGateway, SupabaseOAuthGateway, SupabaseProject } from "./application.js";
import type { DrizzleSupabaseRepository } from "./repository.js";

const REFRESH_EARLY_MS = 5 * 60 * 1000;

export class ManagedSupabaseGateway implements SupabaseGateway, SupabaseOAuthGateway {
  constructor(
    private readonly repository: DrizzleSupabaseRepository,
    private readonly client: SupabaseManagementClient,
    private readonly config: SupabaseOAuthConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  exchangeCode(code: string) {
    return this.client.exchangeCode({ config: this.config, code });
  }

  getProfile(accessToken: string) {
    return this.client.getProfile(accessToken);
  }

  async listProjects(grantId: string): Promise<SupabaseProject[]> {
    return (await this.client.listProjects(await this.accessToken(grantId))).map(toProject);
  }

  async accessToken(grantId: string): Promise<string> {
    const grant = await this.repository.getGrantSecret(grantId);
    if (!grant) throw new Error("Supabase grant not found");
    const expiresAt = grant.tokenExpiresAt?.getTime() ?? 0;
    if (expiresAt > this.now().getTime() + REFRESH_EARLY_MS) return grant.accessToken;
    if (!grant.refreshToken) throw new Error("Supabase grant needs reconnecting");
    const token = await this.client.refreshAccessToken({
      config: this.config,
      refreshToken: grant.refreshToken,
    });
    const tokenExpiresAt = new Date(this.now().getTime() + token.expiresInSeconds * 1000);
    await this.repository.saveGrantTokens(grant.id, {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenExpiresAt,
    });
    return token.accessToken;
  }
}

function toProject(project: ManagementProject): SupabaseProject {
  return {
    ref: project.ref,
    name: project.name,
    organizationSlug: project.organizationSlug,
    region: project.region,
  };
}
