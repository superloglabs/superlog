import path from "node:path";

// Paths an agent-written change may not touch on its own. Agent changes are
// pushed to a branch in the customer's repository, and CI runs on that branch
// before anyone reviews it. CI and automation config, dependency manifests,
// and lockfiles all decide what that CI runs. Agent instruction files steer
// later agent runs. The agent's input includes text from outside the
// workspace (alerts, error messages, logs), so these files stay with people.
export type ProtectedPathCategory = "ci" | "dependencies" | "agent_instructions";

export type AgentWritePolicy = {
  // Projects can let the agent change dependency manifests and lockfiles.
  // CI config and agent instruction files are never writable.
  allowDependencyChanges: boolean;
};

export type RefusedAgentChange = { path: string; category: ProtectedPathCategory };

const CI_FILE_NAMES = new Set([
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  "jenkinsfile",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "bitbucket-pipelines.yml",
  "bitbucket-pipelines.yaml",
  ".pre-commit-config.yaml",
  ".pre-commit-config.yml",
  ".travis.yml",
  "appveyor.yml",
  ".drone.yml",
  "cloudbuild.yaml",
  "cloudbuild.yml",
]);

const CI_DIRECTORIES = new Set([".github", ".gitlab", ".circleci", ".buildkite", ".husky"]);

const DEPENDENCY_FILE_NAMES = new Set([
  ".gitmodules",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "pipfile",
  "pipfile.lock",
  "setup.py",
  "setup.cfg",
  "pip.conf",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.lockfile",
  "mix.exs",
  "mix.lock",
  "packages.lock.json",
  "directory.packages.props",
  "nuget.config",
  "package.swift",
  "package.resolved",
  "podfile",
  "podfile.lock",
  "pubspec.yaml",
  "pubspec.lock",
]);

const AGENT_INSTRUCTION_FILE_NAMES = new Set([
  "agents.md",
  "claude.md",
  "claude.local.md",
  "gemini.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
]);

const AGENT_INSTRUCTION_DIRECTORIES = new Set([".cursor", ".claude", ".windsurf", ".clinerules"]);

function normalizedSegments(filePath: string): string[] {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/").toLowerCase());
  return normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
}

export function protectedPathCategory(filePath: string): ProtectedPathCategory | null {
  const segments = normalizedSegments(filePath);
  const name = segments.at(-1);
  if (!name) return null;
  const directories = segments.slice(0, -1);

  if (directories.some((segment) => CI_DIRECTORIES.has(segment))) return "ci";
  if (CI_FILE_NAMES.has(name)) return "ci";

  if (directories.some((segment) => AGENT_INSTRUCTION_DIRECTORIES.has(segment))) {
    return "agent_instructions";
  }
  if (AGENT_INSTRUCTION_FILE_NAMES.has(name)) return "agent_instructions";

  if (DEPENDENCY_FILE_NAMES.has(name)) return "dependencies";
  if (/^requirements[\w.-]*\.(txt|in)$/.test(name)) return "dependencies";
  if (directories.at(-1) === "requirements" && /\.(txt|in)$/.test(name)) return "dependencies";
  if (/\.(csproj|fsproj|vbproj)$/.test(name)) return "dependencies";
  if (/\.gemspec$/.test(name)) return "dependencies";

  return null;
}

// `submodulePaths` are changed paths whose old or new git mode is a gitlink:
// moving a submodule pointer pulls in another repository's code, so it counts
// as a dependency change whatever the path is called.
export function refusedAgentChanges(
  paths: readonly string[],
  policy: AgentWritePolicy,
  submodulePaths: readonly string[] = [],
): RefusedAgentChange[] {
  const submodules = new Set(submodulePaths);
  const refused: RefusedAgentChange[] = [];
  for (const changedPath of paths) {
    const category = submodules.has(changedPath)
      ? "dependencies"
      : protectedPathCategory(changedPath);
    if (!category) continue;
    if (category === "dependencies" && policy.allowDependencyChanges) continue;
    refused.push({ path: changedPath, category });
  }
  return refused;
}

const CATEGORY_LABELS: Record<ProtectedPathCategory, string> = {
  ci: "CI or automation config",
  dependencies: "dependency manifest or lockfile",
  agent_instructions: "agent instruction file",
};

export function agentWritePolicyError(refused: readonly RefusedAgentChange[]): string {
  const files = refused.map((item) => `${item.path} (${CATEGORY_LABELS[item.category]})`);
  return [
    `This patch changes files that agent pull requests may not change: ${files.join(", ")}.`,
    "Leave these files out of the patch and call propose_pr again with the rest of the fix.",
    "If the fix needs them changed, describe the exact change in the pull request description so a person can make it.",
  ].join(" ");
}

export class AgentWritePolicyError extends Error {
  readonly refused: RefusedAgentChange[];

  constructor(refused: RefusedAgentChange[]) {
    super(agentWritePolicyError(refused));
    this.name = "AgentWritePolicyError";
    this.refused = refused;
  }
}

export function assertAgentChangesAllowed(
  paths: readonly string[],
  policy: AgentWritePolicy,
  submodulePaths: readonly string[] = [],
): void {
  const refused = refusedAgentChanges(paths, policy, submodulePaths);
  if (refused.length > 0) throw new AgentWritePolicyError(refused);
}
