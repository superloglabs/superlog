export type MemoryActivity = {
  type: "memory";
  id: string;
  action: "saved" | "updated";
  kind: string | null;
  memoryId: string | null;
  status: string | null;
  title: string | null;
  body: string | null;
  result: string | null;
  isError: boolean;
};

const MEMORY_TOOLS = new Set(["save_memory", "update_memory"]);

function textArg(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function memoryIdFromResult(result: string | null): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

export function memoryActivityFromTool(
  id: string,
  name: string,
  input: Record<string, unknown>,
  result: string | null,
  isError: boolean,
): MemoryActivity | null {
  if (!MEMORY_TOOLS.has(name)) return null;
  return {
    type: "memory",
    id,
    action: name === "update_memory" ? "updated" : "saved",
    kind: textArg(input, "kind"),
    memoryId: textArg(input, "id") ?? memoryIdFromResult(result),
    status: textArg(input, "status"),
    title: textArg(input, "title"),
    body: textArg(input, "body"),
    result,
    isError,
  };
}
