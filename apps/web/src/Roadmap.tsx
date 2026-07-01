import { Markdown } from "./content/Markdown.tsx";
import { PublicShell } from "./content/PublicShell.tsx";
import roadmapRaw from "./content/ROADMAP.md?raw";
import { parseRoadmap } from "./content/parseRoadmap.ts";

const SECTIONS = parseRoadmap(roadmapRaw);

export function Roadmap() {
  return (
    <PublicShell
      eyebrow="Roadmap"
      title="What we're building"
      subtitle="Where Superlog is headed. Plans shift as we learn — this is direction, not a commitment."
    >
      <div className="grid gap-6 md:grid-cols-3">
        {SECTIONS.map((section) => (
          <section key={section.status} className="rounded-lg border border-border bg-surface p-5">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-subtle">
              {section.status}
            </h2>
            {section.items.length > 0 ? (
              <ul className="mt-5 space-y-4">
                {section.items.map((item, i) => (
                  <li key={i} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
                    <Markdown text={item} inline />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-5 text-[13px] text-subtle">Nothing here yet.</p>
            )}
          </section>
        ))}
      </div>
    </PublicShell>
  );
}
