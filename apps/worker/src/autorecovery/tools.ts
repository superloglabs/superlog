import type Anthropic from "@anthropic-ai/sdk";

// The terminal structured-output tool. Forcing tool_choice on this means
// the agent must call it exactly once (after optionally calling the
// telemetry tools) and that call ends the loop. We parse from `tool_use`,
// never from text.
export const PROPOSE_RESOLUTION_TOOL: Anthropic.Messages.Tool = {
  name: "propose_resolution",
  description:
    "Call exactly once when you've decided whether the incident appears to be resolved. " +
    "This ends the investigation. If you set looks_resolved=false, the incident is left open " +
    "and no human is paged. If looks_resolved=true, a Slack message will be posted asking a " +
    "human to confirm — so prefer being conservative when evidence is weak.",
  input_schema: {
    type: "object",
    properties: {
      looks_resolved: {
        type: "boolean",
        description:
          "True if the incident's underlying error appears to have stopped happening despite the " +
          "expected operation continuing to run successfully. False otherwise.",
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description:
          "How confident you are. 'high' = clear evidence of recovery AND the operation is " +
          "demonstrably working. 'medium' = strong but indirect evidence. 'low' = a hunch.",
      },
      reason_code: {
        type: "string",
        description:
          "Short plain-language label (3-6 lowercase words), e.g. 'external dependency recovered', " +
          "'transient load resolved', 'config or credentials fixed', 'stopped recurring unknown cause'. " +
          "Pick the most specific that fits. No snake_case, no underscores — the dashboard renders " +
          "the text verbatim.",
      },
      reason_text: {
        type: "string",
        description:
          "One or two sentences a teammate sees in Slack explaining *why* this looks resolved and " +
          "what specifically would re-open it if it recurs. Plain text, no markdown.",
      },
      evidence_summary: {
        type: "string",
        description: "Optional bullet-style summary of the queries you ran and what you saw.",
      },
    },
    required: ["looks_resolved", "confidence", "reason_code", "reason_text"],
  },
};

export const QUERY_INCIDENT_ACTIVITY_TOOL: Anthropic.Messages.Tool = {
  name: "query_incident_activity",
  description:
    "Returns hourly counts of exception events on the incident's service whose exception.type " +
    "matches one of the live issues linked to this incident. This is a strict superset of the " +
    "actual incident events (an unrelated issue sharing the same exception type would also " +
    "match), so a non-zero count does not by itself prove the underlying error is still firing — " +
    "but a sustained drop to zero is a strong recovery signal. Use alongside query_service_traffic " +
    "to distinguish recovery from a traffic dropout. Returns zero if the incident has no live " +
    "(non-silenced) linked issues.",
  input_schema: {
    type: "object",
    properties: {
      hours: {
        type: "number",
        description: "Lookback window in hours (1–168). Defaults to 24.",
      },
    },
  },
};

export const QUERY_SERVICE_TRAFFIC_TOOL: Anthropic.Messages.Tool = {
  name: "query_service_traffic",
  description:
    "Returns the total span count for the incident's service over the lookback window, broken " +
    "down by hour. If this is flat or rising while query_incident_activity is zero, the " +
    "operation is still being exercised — strong signal that the error path is genuinely " +
    "recovered, not just unused.",
  input_schema: {
    type: "object",
    properties: {
      hours: {
        type: "number",
        description: "Lookback window in hours (1–168). Defaults to 24.",
      },
    },
  },
};

export const AUTORECOVERY_TOOLS: Anthropic.Messages.Tool[] = [
  QUERY_INCIDENT_ACTIVITY_TOOL,
  QUERY_SERVICE_TRAFFIC_TOOL,
  PROPOSE_RESOLUTION_TOOL,
];

export const AUTORECOVERY_SYSTEM_PROMPT = [
  "You audit open incidents in an observability tool and decide whether each one looks like it",
  "has been resolved *without a code change on our side* — e.g. an external dependency recovered,",
  "a config or credentials issue got fixed manually, or a transient load condition cleared.",
  "",
  "An incident is `open` and has been receiving 0 events for several hours. That alone is NOT",
  "enough to conclude it's resolved: traffic could simply have dropped. Use query_service_traffic",
  "to confirm the parent operation is still being exercised before claiming recovery.",
  "",
  "When you're done, call the `propose_resolution` tool EXACTLY ONCE. Do not write a text reply.",
  "Be conservative: if evidence is weak, set looks_resolved=false or confidence='low'.",
].join("\n");
