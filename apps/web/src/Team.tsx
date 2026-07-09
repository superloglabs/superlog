import { PublicShell } from "./content/PublicShell.tsx";

type Founder = {
  name: string;
  role: string;
  image: string;
  bio: string[];
  links: Array<{ href: string; label: string }>;
};

const FOUNDERS: Founder[] = [
  {
    name: "Nicolò Magnante",
    role: "CEO",
    image: "/team/nicolo-magnante.jpg",
    bio: [
      "Before Superlog, Nicolò worked at BCG and helped scale startups to millions in ARR.",
    ],
    links: [
      { href: "https://x.com/nicolomagnante", label: "X" },
      { href: "https://www.linkedin.com/in/nicol%C3%B2-magnante/", label: "LinkedIn" },
    ],
  },
  {
    name: "Arseniy Shishaev",
    role: "CTO",
    image: "/team/arseniy-shishaev.jpg",
    bio: [
      "Arseniy built data pipelines and tooling at Datadog, co-founded Bluco, and has spent years on production systems that page real teams.",
    ],
    links: [
      { href: "https://x.com/arseniyswish", label: "X" },
      { href: "https://linkedin.com/in/arseniy-shishaev", label: "LinkedIn" },
    ],
  },
];

export function Team() {
  return (
    <PublicShell
      title="Meet the Superlog team"
      subtitle="We want Superlog to delete the debugging loop: observability that installs itself, alerts intelligently, and fixes the bugs."
    >
      <div className="profile-list space-y-14">
        <p className="text-[13px] font-medium text-subtle">
          Founded 2026 · YC Spring 2026 · San Francisco
        </p>

        {FOUNDERS.map((founder, index) => (
          <article
            key={founder.name}
            className={`team-member-row grid gap-4 md:grid-cols-[160px_1fr] ${
              index === 0 ? "border-t-0 pt-0" : "border-t border-border pt-8"
            }`}
          >
            <div className="flex items-start gap-4 md:flex-col">
              <img
                src={founder.image}
                alt={founder.name}
                className="h-16 w-16 shrink-0 rounded-lg object-cover grayscale md:h-20 md:w-20"
                loading="lazy"
                draggable={false}
              />
              <div className="flex flex-wrap gap-2">
                {founder.links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="w-max rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:border-border-strong hover:text-fg"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h2 className="text-[20px] font-semibold tracking-tight text-fg">
                  {founder.name}
                </h2>
                <span className="text-[13px] text-subtle" aria-hidden="true">
                  ·
                </span>
                <p className="text-[15px] font-medium text-muted">{founder.role}</p>
              </div>
              <div className="mt-4 grid gap-4 text-[14px] leading-7 text-muted">
                {founder.bio.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </PublicShell>
  );
}
