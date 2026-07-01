import changelogRaw from "./content/CHANGELOG.md?raw";
import { Markdown } from "./content/Markdown.tsx";
import { PublicShell } from "./content/PublicShell.tsx";
import { type ChangelogEntry, parseChangelog } from "./content/parseChangelog.ts";

const ENTRIES = parseChangelog(changelogRaw);

export function Changelog() {
  return (
    <PublicShell
      eyebrow="Changelog"
      title="What's new"
      subtitle="Fixes, improvements, and new features. Newest first."
    >
      <div className="space-y-14">
        {ENTRIES.map((entry, i) => (
          <Entry key={`${entry.date}-${i}`} entry={entry} />
        ))}
      </div>
    </PublicShell>
  );
}

function Entry({ entry }: { entry: ChangelogEntry }) {
  return (
    <article className="grid gap-4 border-t border-border pt-8 first:border-t-0 first:pt-0 md:grid-cols-[160px_1fr]">
      <div className="flex flex-col gap-3">
        {entry.date && (
          <time className="font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">
            {formatDate(entry.date)}
          </time>
        )}
        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.tags.map((tag) => (
              <span
                key={tag}
                className="w-max rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <h2 className="text-[20px] font-semibold tracking-tight text-fg">{entry.title}</h2>
        {entry.body && (
          <div className="mt-4">
            <Markdown text={entry.body} />
          </div>
        )}
      </div>
    </article>
  );
}

function formatDate(iso: string): string {
  // Parse as UTC to avoid a local-timezone off-by-one on the rendered day.
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
