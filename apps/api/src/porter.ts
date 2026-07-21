import { mintApiKey } from "@superlog/db";
import type { Hono } from "hono";
import { requireProjectManagerContext } from "./org-authorization-http.js";

type Vars = { userId: string; orgId: string | null };

const PORTER_SETUP = {
  dashboardUrl: "https://dashboard.porter.run",
  addonName: "superlog-otel",
  chart: {
    repositoryUrl: "https://superloglabs.github.io/helm-charts",
    name: "superlog-otel",
    version: "0.1.1",
  },
} as const;

type MintIngestKey = typeof mintApiKey;

async function createPorterSetup(projectId: string, mintIngestKey: MintIngestKey) {
  const key = await mintIngestKey({ projectId, name: "Porter Helm install" });
  return {
    ...PORTER_SETUP,
    key: {
      id: key.id,
      prefix: key.keyPrefix,
      plaintext: key.plaintext,
    },
    valuesYaml: `global:\n  superlog:\n    apiKey: ${key.plaintext}\n`,
  };
}

export function mountPorterAuthed(
  app: Hono<{ Variables: Vars }>,
  deps: { mintIngestKey?: MintIngestKey } = {},
): void {
  const mintIngestKey = deps.mintIngestKey ?? mintApiKey;

  app.post("/api/projects/:projectId/integrations/porter/setup", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectManagerContext(c, projectId);
    return c.json(await createPorterSetup(projectId, mintIngestKey));
  });
}
