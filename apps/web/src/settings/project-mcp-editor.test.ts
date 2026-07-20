import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMcpServer } from "../api.ts";
import {
  EMPTY_AUTH,
  createDetectedProjectMcpAuthDraft,
  createProjectMcpEditorDraft,
  detectProjectMcpAuthSafely,
  projectMcpAuthDetectionIsCurrent,
  projectMcpAuthDraftAfterUrlChange,
  projectMcpAuthSelectionAfterUrlChange,
  resolveProjectMcpAuthForSubmit,
  resolveSelectedScopes,
  shouldDetectProjectMcpAuth,
  toggleScopeSelection,
} from "./project-mcp-editor.ts";

test("opening an MCP editor starts from the persisted server instead of a stale draft", () => {
  const server = {
    id: "server-1",
    name: "linear",
    slug: "linear",
    url: "https://linear.example/mcp",
    enabled: true,
    auth: {
      type: "oauth",
      grantType: "authorization_code",
      status: "pending",
      scopes: ["issues:read"],
      hasCredential: false,
      expiresAt: null,
    },
  } as ProjectMcpServer;

  assert.deepEqual(createProjectMcpEditorDraft(server), {
    name: "linear",
    url: "https://linear.example/mcp",
    trusted: false,
    replaceAuth: false,
    auth: {
      type: "oauth",
      token: "",
      headerName: "X-API-Key",
      key: "",
      grantType: "authorization_code",
      scopes: "issues:read",
      advertisedScopes: [],
      clientId: "",
      clientSecret: "",
      requiresClientId: false,
    },
  });
});

test("detected OAuth becomes the form auth draft while unknown auth stays credential-free", () => {
  assert.deepEqual(
    createDetectedProjectMcpAuthDraft({
      type: "oauth",
      grantType: "authorization_code",
      supportsDynamicRegistration: true,
      scopesSupported: ["issues:read", "issues:write"],
    }),
    {
      type: "oauth",
      token: "",
      headerName: "X-API-Key",
      key: "",
      grantType: "authorization_code",
      scopes: "",
      advertisedScopes: ["issues:read", "issues:write"],
      clientId: "",
      clientSecret: "",
      requiresClientId: false,
    },
  );
  assert.deepEqual(createDetectedProjectMcpAuthDraft({ type: "unknown" }), {
    type: "none",
    token: "",
    headerName: "X-API-Key",
    key: "",
    grantType: "authorization_code",
    scopes: "",
    advertisedScopes: [],
    clientId: "",
    clientSecret: "",
    requiresClientId: false,
  });
});

test("detected OAuth without dynamic registration requires manual client credentials", () => {
  assert.deepEqual(
    createDetectedProjectMcpAuthDraft({
      type: "oauth",
      grantType: "authorization_code",
      supportsDynamicRegistration: false,
      scopesSupported: [],
    }),
    {
      type: "oauth",
      token: "",
      headerName: "X-API-Key",
      key: "",
      grantType: "authorization_code",
      scopes: "",
      advertisedScopes: [],
      clientId: "",
      clientSecret: "",
      requiresClientId: true,
    },
  );
});

test("detected client-credentials OAuth requires manual credentials even with registration", () => {
  assert.equal(
    createDetectedProjectMcpAuthDraft({
      type: "oauth",
      grantType: "client_credentials",
      supportsDynamicRegistration: true,
      scopesSupported: [],
    }).requiresClientId,
    true,
  );
});

test("changing the URL resets auth forced by detection but preserves an explicit manual choice", () => {
  assert.equal(projectMcpAuthSelectionAfterUrlChange("required"), "automatic");
  assert.equal(projectMcpAuthSelectionAfterUrlChange("manual"), "manual");
});

test("changing a manual OAuth URL clears scopes advertised by the old resource", () => {
  const draft = {
    ...EMPTY_AUTH,
    type: "oauth" as const,
    scopes: "projects:read",
    advertisedScopes: ["projects:read", "database:read"],
  };

  assert.deepEqual(projectMcpAuthDraftAfterUrlChange(draft), {
    ...draft,
    advertisedScopes: [],
  });
});

test("automatic auth detection requires an URL and explicit trust confirmation", () => {
  assert.equal(shouldDetectProjectMcpAuth("automatic", "https://mcp.example/mcp", false), false);
  assert.equal(shouldDetectProjectMcpAuth("automatic", "", true), false);
  assert.equal(shouldDetectProjectMcpAuth("manual", "https://mcp.example/mcp", true), false);
  assert.equal(shouldDetectProjectMcpAuth("automatic", "https://mcp.example/mcp", true), true);
});

test("auth detection results are current only while the requested URL is unchanged", () => {
  assert.equal(
    projectMcpAuthDetectionIsCurrent("https://old.example/mcp", "https://new.example/mcp"),
    false,
  );
  assert.equal(
    projectMcpAuthDetectionIsCurrent("https://mcp.example/mcp", "https://mcp.example/mcp"),
    true,
  );
});

test("automatic auth detection fails closed when discovery errors", async () => {
  assert.equal(
    await detectProjectMcpAuthSafely(async () => {
      throw new Error("discovery failed");
    }),
    null,
  );
});

test("an empty scope selection resolves to every advertised scope", () => {
  const advertised = ["projects:read", "database:read", "storage:read"];
  assert.deepEqual(resolveSelectedScopes("", advertised), advertised);
  assert.deepEqual(resolveSelectedScopes("   ", advertised), advertised);
  assert.deepEqual(resolveSelectedScopes("projects:read database:read", advertised), [
    "projects:read",
    "database:read",
  ]);
});

test("toggling a scope customizes the selection and keeps advertised order", () => {
  const advertised = ["projects:read", "database:read", "storage:read"];
  // From the "all" default, unchecking one produces an explicit remainder.
  assert.equal(toggleScopeSelection("", advertised, "database:read"), "projects:read storage:read");
  // Re-adding it keeps advertised order rather than append order.
  assert.equal(toggleScopeSelection("storage:read projects:read", advertised, "database:read"), "");
  // Reaching the full set again normalizes back to "" (request all).
  assert.equal(toggleScopeSelection("projects:read database:read", advertised, "storage:read"), "");
});

test("toggling the last selected scope keeps a non-empty selection", () => {
  const advertised = ["projects:read", "database:read"];

  assert.equal(toggleScopeSelection("projects:read", advertised, "projects:read"), "projects:read");
});

test("submitting an unchanged detected URL keeps its customized OAuth scopes", async () => {
  const draft = {
    ...EMPTY_AUTH,
    type: "oauth" as const,
    scopes: "projects:read",
    advertisedScopes: ["projects:read", "database:read"],
  };
  let detectionCalls = 0;

  const result = await resolveProjectMcpAuthForSubmit({
    selection: "automatic",
    draft,
    detectedUrl: "https://mcp.example/mcp",
    currentUrl: "https://mcp.example/mcp",
    detect: async () => {
      detectionCalls += 1;
      return EMPTY_AUTH;
    },
  });

  assert.equal(result, draft);
  assert.equal(detectionCalls, 0);
});

test("submitting a changed automatic URL discovers its authentication again", async () => {
  const discovered = { ...EMPTY_AUTH, type: "oauth" as const };
  let detectionCalls = 0;

  const result = await resolveProjectMcpAuthForSubmit({
    selection: "automatic",
    draft: EMPTY_AUTH,
    detectedUrl: "https://old.example/mcp",
    currentUrl: "https://new.example/mcp",
    detect: async () => {
      detectionCalls += 1;
      return discovered;
    },
  });

  assert.equal(result, discovered);
  assert.equal(detectionCalls, 1);
});
