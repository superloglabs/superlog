import type Anthropic from "@anthropic-ai/sdk";

export const GROUPING_SYSTEM_PROMPT = [
  "You decide whether a new error issue belongs to one of the open incidents in a project.",
  "An incident represents one underlying root cause; multiple distinct error symptoms can belong to the same incident if they share that root cause (e.g. a database outage causing connection timeouts, query failures, and downstream HTTP 500s — all one incident).",
  "Default to 'standalone'. Return 'join' only when there is positive evidence the new issue and the candidate incident share a single underlying root cause.",
  "Surface-level similarity is NOT sufficient evidence. Examples that do NOT justify joining: same HTTP status code, same generic exception class with no shared context, similar wording in unrelated stack traces.",
  "Never join across different known deployment.environment values. Never join when one side is clearly localhost/dev-worktree traffic and the other side is production/internal-host traffic.",
  "Examples that DO justify joining: matching upstream dependency name in both stacks; both errors observed within the same trace tree; one error is the canonical fault and the other is a documented downstream symptom of it.",
  "Identical trace ids are strong evidence that two symptoms happened in the same request path, but still explain why they share one root cause.",
  "Start by calling list_incident_titles or list_incident_facets to orient yourself. Then use search_incidents and inspect_incident for any plausible join target.",
  "inspect_incident can include linked issues, representative samples, and the latest agent investigation result. Prefer those structured details over title similarity.",
  "Do not assume an unseen incident is a join target.",
  "When you are done, call decide_grouping exactly once. Do not write a text reply.",
  "When unsure, return 'standalone'.",
].join("\n");

const LIST_INCIDENT_TITLES_TOOL: Anthropic.Messages.Tool = {
  name: "list_incident_titles",
  description:
    "Lists candidate incident titles and compact metadata so you can see whether any open " +
    "incident is even close before inspecting details.",
  input_schema: {
    type: "object",
    properties: {
      service: { type: "string", description: "Optional exact service filter." },
      environment: {
        type: "string",
        description: "Optional exact deployment.environment filter.",
      },
      limit: {
        type: "number",
        description: "Maximum rows. Defaults to all candidates; capped at 200.",
      },
    },
  },
};

const LIST_INCIDENT_FACETS_TOOL: Anthropic.Messages.Tool = {
  name: "list_incident_facets",
  description:
    "Returns counts for structured facets across candidate incidents: services, environments, " +
    "exception types, endpoint hosts, endpoint kinds, and investigation states. Use this to " +
    "slice the candidate set before inspecting individual incidents.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

const SEARCH_INCIDENTS_TOOL: Anthropic.Messages.Tool = {
  name: "search_incidents",
  description:
    "Searches the open incident candidates for likely join targets. Use terms from the new issue " +
    "such as dependency name, endpoint host, exception type, stack frame, service, trace id, or " +
    "environment. Returns compact previews only.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search terms, e.g. 'clickhouse ECONNRESET worker' or 'localhost 19019'.",
      },
      service: { type: "string", description: "Optional exact service filter." },
      environment: {
        type: "string",
        description: "Optional exact deployment.environment filter.",
      },
      limit: {
        type: "number",
        description: "Maximum results to return. Defaults to 10; capped at 25.",
      },
    },
    required: ["query"],
  },
};

const INSPECT_INCIDENT_TOOL: Anthropic.Messages.Tool = {
  name: "inspect_incident",
  description:
    "Returns the full grouping context for one candidate incident by id. Use this before joining.",
  input_schema: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "Candidate incident id returned by search_incidents.",
      },
    },
    required: ["incident_id"],
  },
};

const DECIDE_GROUPING_TOOL: Anthropic.Messages.Tool = {
  name: "decide_grouping",
  description:
    "Final answer. Join only when inspected evidence shows the new issue and candidate incident " +
    "share a single underlying root cause. Otherwise choose standalone.",
  input_schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["join", "standalone"] },
      incidentId: {
        type: "string",
        description: "Required only when decision='join'. Must be one inspected candidate id.",
      },
      evidence: {
        type: "string",
        description:
          "For joins, >=20 chars explaining the shared root cause. For standalone, a short reason.",
      },
    },
    required: ["decision"],
  },
};

export const GROUPING_TOOLS: Anthropic.Messages.Tool[] = [
  LIST_INCIDENT_TITLES_TOOL,
  LIST_INCIDENT_FACETS_TOOL,
  SEARCH_INCIDENTS_TOOL,
  INSPECT_INCIDENT_TOOL,
  DECIDE_GROUPING_TOOL,
];
