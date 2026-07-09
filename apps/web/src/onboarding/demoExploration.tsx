import { type ReactNode, createContext, useContext } from "react";

const DEMO_EXPLORING_KEY = "superlog.demo_exploring";

type DemoExplorationState = {
  demoMode: boolean;
  exploring: boolean;
  stopExploring: () => void;
};

const defaultDemoExploration: DemoExplorationState = {
  demoMode: false,
  exploring: false,
  stopExploring: () => {},
};

const DemoExplorationContext = createContext<DemoExplorationState>(defaultDemoExploration);

export function readDemoExploring(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEMO_EXPLORING_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDemoExploring(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (on) window.localStorage.setItem(DEMO_EXPLORING_KEY, "1");
    else window.localStorage.removeItem(DEMO_EXPLORING_KEY);
  } catch {
    /* ignore */
  }
}

export function DemoExplorationProvider({
  value,
  children,
}: {
  value: DemoExplorationState;
  children: ReactNode;
}) {
  return (
    <DemoExplorationContext.Provider value={value}>{children}</DemoExplorationContext.Provider>
  );
}

export function useDemoExploration(): DemoExplorationState {
  return useContext(DemoExplorationContext);
}
