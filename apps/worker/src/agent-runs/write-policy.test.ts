import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentWritePolicyError,
  protectedPathCategory,
  refusedAgentChanges,
} from "./write-policy.js";

test("CI and automation config is protected at any depth of .github and in known CI files", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    ".github/dependabot.yml",
    ".github/CODEOWNERS",
    ".GitHub/Workflows/Deploy.YML",
    "services/api/.github/workflows/x.yml",
    ".gitlab-ci.yml",
    ".gitlab/ci/build.yml",
    ".circleci/config.yml",
    "Jenkinsfile",
    "ci/Jenkinsfile",
    ".buildkite/pipeline.yml",
    "azure-pipelines.yml",
    "bitbucket-pipelines.yml",
    ".pre-commit-config.yaml",
    ".husky/pre-commit",
  ]) {
    assert.equal(protectedPathCategory(path), "ci", path);
  }
});

test("dependency manifests and lockfiles are protected at any depth", () => {
  for (const path of [
    "package.json",
    "apps/web/package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "npm-shrinkwrap.json",
    ".npmrc",
    ".yarnrc.yml",
    "requirements.txt",
    "requirements-dev.txt",
    "requirements/prod.txt",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    "Pipfile.lock",
    "setup.py",
    "setup.cfg",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "Gemfile",
    "Gemfile.lock",
    "composer.json",
    "composer.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gradle.lockfile",
    "mix.exs",
    "mix.lock",
    "src/App/App.csproj",
    "packages.lock.json",
    ".gitmodules",
    "MODULE.bazel",
    "WORKSPACE.bazel",
    "gradle/libs.versions.toml",
    "gradle/wrapper/gradle-wrapper.properties",
    "environment.yml",
    "conanfile.txt",
    "vcpkg.json",
    "flake.lock",
    "Project.toml",
    "stack.yaml",
    "app.cabal",
    "renv.lock",
  ]) {
    assert.equal(protectedPathCategory(path), "dependencies", path);
  }
});

test("agent instruction files are protected", () => {
  for (const path of [
    "AGENTS.md",
    "CLAUDE.md",
    "apps/api/claude.md",
    ".cursorrules",
    ".cursor/rules/style.mdc",
    ".claude/settings.json",
    "GEMINI.md",
  ]) {
    assert.equal(protectedPathCategory(path), "agent_instructions", path);
  }
  assert.equal(protectedPathCategory(".github/copilot-instructions.md"), "ci");
});

test("ordinary source, tests and docs are not protected", () => {
  for (const path of [
    "src/index.ts",
    "apps/api/src/package-json.ts",
    "src/requirements.py",
    "docs/ci.md",
    "README.md",
    "tests/github/workflow.test.ts",
    "lib/go.module.ts",
  ]) {
    assert.equal(protectedPathCategory(path), null, path);
  }
});

test("paths are normalized before matching", () => {
  assert.equal(protectedPathCategory("./.github/workflows/ci.yml"), "ci");
  assert.equal(protectedPathCategory("a/../.github/workflows/ci.yml"), "ci");
  assert.equal(protectedPathCategory("src//package.json"), "dependencies");
  assert.equal(protectedPathCategory("src\\package.json"), "dependencies");
});

test("dependency changes pass only when the project allows them; CI and instructions never do", () => {
  const paths = ["src/a.ts", "package.json", ".github/workflows/ci.yml", "AGENTS.md"];
  assert.deepEqual(refusedAgentChanges(paths, { allowDependencyChanges: false }), [
    { path: "package.json", category: "dependencies" },
    { path: ".github/workflows/ci.yml", category: "ci" },
    { path: "AGENTS.md", category: "agent_instructions" },
  ]);
  assert.deepEqual(refusedAgentChanges(paths, { allowDependencyChanges: true }), [
    { path: ".github/workflows/ci.yml", category: "ci" },
    { path: "AGENTS.md", category: "agent_instructions" },
  ]);
  assert.deepEqual(refusedAgentChanges(["src/a.ts"], { allowDependencyChanges: false }), []);
});

test("the refusal names each file and tells the agent what to do instead", () => {
  const message = agentWritePolicyError([
    { path: "package.json", category: "dependencies" },
    { path: ".github/workflows/ci.yml", category: "ci" },
  ]);
  assert.match(message, /package\.json/);
  assert.match(message, /\.github\/workflows\/ci\.yml/);
  assert.match(message, /leave .* out of the patch/i);
  assert.match(message, /pull request description/i);
});

test("submodule pointer changes count as dependency changes", () => {
  assert.deepEqual(
    refusedAgentChanges(["vendor/lib"], { allowDependencyChanges: false }, ["vendor/lib"]),
    [{ path: "vendor/lib", category: "dependencies" }],
  );
  assert.deepEqual(
    refusedAgentChanges(["vendor/lib"], { allowDependencyChanges: true }, ["vendor/lib"]),
    [],
  );
});
