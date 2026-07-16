import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMcpServer } from "../api.ts";
import {
  createDetectedProjectMcpAuthDraft,
  createProjectMcpEditorDraft,
  projectMcpAuthSelectionAfterUrlChange,
  projectMcpAuthDetectionIsCurrent,
  shouldDetectProjectMcpAuth,
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
    }),
    {
      type: "oauth",
      token: "",
      headerName: "X-API-Key",
      key: "",
      grantType: "authorization_code",
      scopes: "",
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
    }),
    {
      type: "oauth",
      token: "",
      headerName: "X-API-Key",
      key: "",
      grantType: "authorization_code",
      scopes: "",
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
    }).requiresClientId,
    true,
  );
});

test("changing the URL resets auth forced by detection but preserves an explicit manual choice", () => {
  assert.equal(projectMcpAuthSelectionAfterUrlChange("required"), "automatic");
  assert.equal(projectMcpAuthSelectionAfterUrlChange("manual"), "manual");
});

test("automatic auth detection requires an URL and explicit trust confirmation", () => {
  assert.equal(shouldDetectProjectMcpAuth("automatic", "https://mcp.example/mcp", false), false);
  assert.equal(shouldDetectProjectMcpAuth("automatic", "", true), false);
  assert.equal(shouldDetectProjectMcpAuth("manual", "https://mcp.example/mcp", true), false);
  assert.equal(shouldDetectProjectMcpAuth("automatic", "https://mcp.example/mcp", true), true);
});

test("auth detection results are current only while the requested URL is unchanged", () => {
  assert.equal(
    projectMcpAuthDetectionIsCurrent(
      "https://old.example/mcp",
      "https://new.example/mcp",
    ),
    false,
  );
  assert.equal(
    projectMcpAuthDetectionIsCurrent(
      "https://mcp.example/mcp",
      "https://mcp.example/mcp",
    ),
    true,
  );
});
