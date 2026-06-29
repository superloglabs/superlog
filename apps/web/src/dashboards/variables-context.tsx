import { createContext, useContext } from "react";

// Current dashboard variable selections (name → selected value), provided by
// DashboardView and consumed by widgets so their filters resolve `$name`
// references at view time. Empty in previews / standalone widget rendering.
const VariableValuesContext = createContext<Record<string, string>>({});

export const VariableValuesProvider = VariableValuesContext.Provider;

export function useVariableValues(): Record<string, string> {
  return useContext(VariableValuesContext);
}
