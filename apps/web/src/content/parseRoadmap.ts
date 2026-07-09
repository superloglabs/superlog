// Parses the public ROADMAP.md into status columns. Each `## ` heading is a
// column (e.g. "Now" / "Next" / "Later"); the bullet list under it becomes the
// column's items. Item text is raw markdown, rendered inline by the page.

export type RoadmapSection = {
  status: string;
  items: string[];
};

const HEADING_RE = /^##\s+(.*\S)\s*$/;
const BULLET_RE = /^[-*]\s+(.*)$/;

export function parseRoadmap(input: string): RoadmapSection[] {
  const lines = input.split("\n");
  const sections: RoadmapSection[] = [];
  let current: RoadmapSection | null = null;

  for (const line of lines) {
    const h = line.match(HEADING_RE);
    if (h) {
      current = { status: h[1]!, items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;

    const b = line.match(BULLET_RE);
    if (b) {
      current.items.push(b[1]!.trim());
      continue;
    }
    // A non-blank, non-bullet line continues the previous item (wrapped text).
    if (line.trim() !== "" && current.items.length > 0) {
      const last = current.items.length - 1;
      current.items[last] = `${current.items[last]} ${line.trim()}`;
    }
  }

  return sections;
}
