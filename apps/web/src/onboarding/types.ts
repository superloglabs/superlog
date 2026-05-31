import type { ReactNode } from "react";

export type TodoId = "github" | "slack" | "deploy" | "mcp";

export type Todo = {
  id: TodoId;
  icon: ReactNode;
  title: string;
  desc: string;
  cta: string;
  variant: "primary" | "secondary";
};
