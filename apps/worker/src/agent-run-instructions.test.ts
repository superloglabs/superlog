import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentRunInstructions } from "./agent-run-instructions.js";

test("buildAgentRunInstructions combines org guidance, project context, and project instructions", () => {
  const result = buildAgentRunInstructions({
    orgInstructions: "Prefer small patches.",
    projectContext: "This project is the billing API. Stripe IDs are customer-scoped.",
    projectInstructions: "Run billing tests before opening a PR.",
  });

  assert.equal(
    result,
    [
      "Prefer small patches.",
      "Project context:\nThis project is the billing API. Stripe IDs are customer-scoped.",
      "Run billing tests before opening a PR.",
    ].join("\n\n"),
  );
});

test("buildAgentRunInstructions omits project context section when projectContext is empty or whitespace", () => {
  const resultEmpty = buildAgentRunInstructions({
    orgInstructions: "Always run linters.",
    projectContext: "",
    projectInstructions: "Check for breaking API changes.",
  });

  assert.equal(
    resultEmpty,
    ["Always run linters.", "Check for breaking API changes."].join("\n\n"),
  );

  const resultWhitespace = buildAgentRunInstructions({
    orgInstructions: "Always run linters.",
    projectContext: "   \n\t   ",
    projectInstructions: "Check for breaking API changes.",
  });

  assert.equal(
    resultWhitespace,
    ["Always run linters.", "Check for breaking API changes."].join("\n\n"),
  );
  assert.ok(!resultWhitespace.includes("Project context:"));
});

test("buildAgentRunInstructions returns only org instructions when project fields are empty", () => {
  const result = buildAgentRunInstructions({
    orgInstructions: "Adhere to semantic versioning.",
    projectContext: "",
    projectInstructions: "",
  });

  assert.equal(result, "Adhere to semantic versioning.");
});

test("buildAgentRunInstructions returns only project instructions when org and context are empty", () => {
  const result = buildAgentRunInstructions({
    orgInstructions: "",
    projectContext: "   ",
    projectInstructions: "Target node 22 runtime.",
  });

  assert.equal(result, "Target node 22 runtime.");
});

test("buildAgentRunInstructions formats standalone project context when instructions are empty", () => {
  const result = buildAgentRunInstructions({
    orgInstructions: "",
    projectContext: "E-commerce checkout microservice.",
    projectInstructions: "",
  });

  assert.equal(result, "Project context:\nE-commerce checkout microservice.");
});

test("buildAgentRunInstructions trims surrounding whitespace from each section", () => {
  const result = buildAgentRunInstructions({
    orgInstructions: "  \n  Write descriptive commit messages. \n ",
    projectContext: "\n  Database uses PostgreSQL with Drizzle ORM.  \n\t",
    projectInstructions: " \n Do not edit generated migration files directly.  \n",
  });

  assert.equal(
    result,
    [
      "Write descriptive commit messages.",
      "Project context:\nDatabase uses PostgreSQL with Drizzle ORM.",
      "Do not edit generated migration files directly.",
    ].join("\n\n"),
  );
});

test("buildAgentRunInstructions returns empty string when all inputs are empty or whitespace", () => {
  const result = buildAgentRunInstructions({
    orgInstructions: "   \n  ",
    projectContext: "\t  ",
    projectInstructions: "",
  });

  assert.equal(result, "");
});

test("buildAgentRunInstructions preserves internal newlines in multiline context and instructions", () => {
  const result = buildAgentRunInstructions({
    orgInstructions: "General rule 1.\nGeneral rule 2.",
    projectContext: "Service A handles auth.\nService B handles billing.",
    projectInstructions: "Step 1: check types.\nStep 2: run tests.",
  });

  assert.equal(
    result,
    [
      "General rule 1.\nGeneral rule 2.",
      "Project context:\nService A handles auth.\nService B handles billing.",
      "Step 1: check types.\nStep 2: run tests.",
    ].join("\n\n"),
  );
});
