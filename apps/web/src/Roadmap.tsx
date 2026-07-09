import { Markdown } from "./content/Markdown.tsx";
import { PublicShell } from "./content/PublicShell.tsx";
// Canonical ROADMAP.md at the repo root; Vite inlines it at build time.
import roadmapRaw from "../../../ROADMAP.md?raw";
import { parseRoadmap } from "./content/parseRoadmap.ts";

const SECTIONS = parseRoadmap(roadmapRaw);

export function Roadmap() {
  return (
    <PublicShell
      eyebrow="Roadmap"
      title="What we're building"
      subtitle="Where Superlog is headed. Plans shift as we learn — this is direction, not a commitment."
    >
      <div className="space-y-14">
        {SECTIONS.map((section) => (
          <section
            key={section.status}
            className="grid gap-4 border-t border-border pt-8 first:border-t-0 first:pt-0 md:grid-cols-[160px_1fr]"
          >
            <h2 className="text-[13px] font-semibold tracking-tight text-subtle">
              {section.status}
            </h2>
            {section.items.length > 0 ? (
              <ul className="min-w-0 space-y-4">
                {section.items.map((item, i) => (
                  <li
                    key={i}
                    className="border-border border-t pt-4 first:border-t-0 first:pt-0"
                  >
                    <Markdown text={item} inline />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-subtle">Nothing here yet.</p>
            )}
          </section>
        ))}
      </div>
    </PublicShell>
  );
}
