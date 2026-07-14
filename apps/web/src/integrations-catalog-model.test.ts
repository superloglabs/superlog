import assert from "node:assert/strict";
import test from "node:test";
import {
  type IntegrationCatalogItem,
  filterAvailableIntegrations,
  partitionIntegrations,
} from "./settings/integrationsCatalogModel.ts";

const items: IntegrationCatalogItem[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Open pull requests from investigations.",
    category: "Developer tools",
    keywords: ["source control", "repositories"],
    installed: true,
  },
  {
    id: "aws",
    name: "AWS",
    description: "Stream CloudWatch telemetry.",
    category: "Cloud platforms",
    keywords: ["amazon", "cloudwatch"],
    installed: false,
  },
  {
    id: "notion",
    name: "Notion",
    description: "Read runbooks and architecture notes.",
    category: "Knowledge",
    keywords: ["docs", "wiki"],
    installed: false,
  },
];

test("integration catalog separates configured integrations from ones that can be added", () => {
  assert.deepEqual(partitionIntegrations(items), {
    configured: [items[0]],
    available: [items[1], items[2]],
  });
});

test("available integrations can be searched by name, description, category, or keyword", () => {
  assert.deepEqual(
    filterAvailableIntegrations(items, "amazon").map((item) => item.id),
    ["aws"],
  );
  assert.deepEqual(
    filterAvailableIntegrations(items, "architecture").map((item) => item.id),
    ["notion"],
  );
  assert.deepEqual(
    filterAvailableIntegrations(items, "cloud platforms").map((item) => item.id),
    ["aws"],
  );
  assert.deepEqual(
    filterAvailableIntegrations(items, "git").map((item) => item.id),
    [],
    "configured integrations stay out of the add catalog",
  );
});

test("blank searches return every available integration in catalog order", () => {
  assert.deepEqual(
    filterAvailableIntegrations(items, "   ").map((item) => item.id),
    ["aws", "notion"],
  );
});
