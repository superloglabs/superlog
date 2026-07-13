import type { ReactNode } from "react";

export function IncidentDetailScrollArea({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-6 lg:px-8">
      {children}
    </div>
  );
}
