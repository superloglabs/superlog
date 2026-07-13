export function isDetailWorkspacePath(pathname: string) {
  return /^\/(?:issues|incidents)\/[^/]+\/?$/.test(pathname);
}

// The authenticated app frame is pinned to the viewport height rather than
// `min-h-screen`. A `min-h-screen` frame is free to grow past the viewport, so a
// tall route (e.g. the incident detail's activity timeline) scrolls the whole
// document and the route's own `overflow-y-auto` region never engages. Pinning
// the frame to `100dvh` and clipping its overflow keeps the sticky chrome fixed
// and lets each route scroll inside its own container — so the incident timeline
// scrolls in `IncidentDetailScrollArea`, not by growing the page.
export const APP_FRAME_CLASS = "flex h-[100dvh] flex-col overflow-hidden bg-bg";

// Ordinary (non-detail) routes — overview, lists, settings — are still plain
// scrolling pages, but under a viewport-bounded frame they must scroll inside
// their own container instead of the document body.
export const PAGE_SCROLL_CONTAINER_CLASS = "min-h-0 flex-1 overflow-y-auto";
