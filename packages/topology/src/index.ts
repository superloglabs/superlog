// @superlog/topology — framework-agnostic topology model + builders.
//
// Pure, dependency-free logic shared by the worker (builds a topology from live
// inventory + telemetry, then runs the LLM enrichment) and the web renderer. The
// React canvas itself lives in apps/web; everything here is plain data + functions.

export * from "./topology.js";
export * from "./providers.js";
export * from "./services.js";
export * from "./enrich.js";
export * from "./layout.js";
