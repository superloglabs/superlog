import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMcpServer } from "../api.ts";
import { createProjectMcpEditorDraft } from "./project-mcp-editor.ts";

test("opening an MCP editor starts from the persisted server instead of a stale draft", () => {
  const server = {
    id: "server-1",
    name: "linear",
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
    },
  });
});
