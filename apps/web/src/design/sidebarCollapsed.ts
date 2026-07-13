const SIDEBAR_COLLAPSED_KEY = "superlog.sidebar.collapsed";

export function readSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (collapsed) window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    else window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  } catch {
    /* ignore */
  }
}
