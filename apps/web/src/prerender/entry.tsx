import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { BLOG_POSTS } from "../blogPosts.ts";
import { MarketingApp } from "../marketing/MarketingApp.tsx";

type PublicPage = {
  path: string;
  title: string;
  description: string;
  ogType?: "website" | "article";
  publishedTime?: string;
  author?: string;
  lastModified: string;
  structuredData?: Record<string, unknown>;
};

const SITE_ORIGIN = "https://superlog.sh";
const SITE_CONTENT_LAST_MODIFIED = "2026-07-22";
const SOCIAL_IMAGE_ALT = "Superlog wordmark over a blue and violet abstract background";
const pages: PublicPage[] = [
  {
    path: "/",
    title: "Superlog | Observability that fixes your bugs",
    description:
      "AI-native observability that groups incidents, investigates production telemetry, and prepares fixes.",
    lastModified: SITE_CONTENT_LAST_MODIFIED,
    structuredData: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": `${SITE_ORIGIN}/#organization`,
          name: "Superlog",
          url: SITE_ORIGIN,
          description:
            "AI-native observability that groups incidents, investigates production telemetry, and prepares fixes.",
          logo: {
            "@type": "ImageObject",
            url: `${SITE_ORIGIN}/web-app-manifest-512x512.png`,
            width: 512,
            height: 512,
          },
          sameAs: ["https://github.com/superloglabs/superlog"],
        },
        {
          "@type": "WebSite",
          "@id": `${SITE_ORIGIN}/#website`,
          name: "Superlog",
          url: SITE_ORIGIN,
          publisher: { "@id": `${SITE_ORIGIN}/#organization` },
          inLanguage: "en",
        },
      ],
    },
  },
  {
    path: "/pricing",
    title: "Pricing | Superlog",
    description:
      "Start with free OpenTelemetry ingest and pay only for the telemetry and investigations your team uses.",
    lastModified: SITE_CONTENT_LAST_MODIFIED,
  },
  {
    path: "/blog",
    title: "Blog | Superlog",
    description: "Product updates, engineering notes, and lessons from building Superlog.",
    lastModified: SITE_CONTENT_LAST_MODIFIED,
  },
  ...BLOG_POSTS.map((post) => {
    const url = `${SITE_ORIGIN}/blog/${post.slug}`;
    const description = post.excerpt || `Read ${post.title} on the Superlog blog.`;
    return {
      path: `/blog/${post.slug}`,
      title: `${post.title} | Superlog`,
      description,
      ogType: "article" as const,
      publishedTime: post.date,
      author: post.author,
      lastModified: post.date,
      structuredData: {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "BlogPosting",
            "@id": `${url}/#article`,
            headline: post.title,
            description,
            image: `${SITE_ORIGIN}/og-image.png`,
            datePublished: post.date,
            dateModified: post.date,
            author: {
              "@type": "Person",
              name: post.author || "Superlog",
              url: `${SITE_ORIGIN}/team`,
            },
            publisher: {
              "@type": "Organization",
              "@id": `${SITE_ORIGIN}/#organization`,
              name: "Superlog",
              logo: {
                "@type": "ImageObject",
                url: `${SITE_ORIGIN}/web-app-manifest-512x512.png`,
                width: 512,
                height: 512,
              },
            },
            mainEntityOfPage: { "@type": "WebPage", "@id": url },
          },
          {
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: "Home",
                item: SITE_ORIGIN,
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Blog",
                item: `${SITE_ORIGIN}/blog`,
              },
              {
                "@type": "ListItem",
                position: 3,
                name: post.title,
                item: url,
              },
            ],
          },
        ],
      },
    };
  }),
  {
    path: "/changelog",
    title: "Changelog | Superlog",
    description:
      "See the latest product improvements, fixes, and integrations shipped by Superlog.",
    lastModified: SITE_CONTENT_LAST_MODIFIED,
  },
  {
    path: "/roadmap",
    title: "Roadmap | Superlog",
    description: "See what the Superlog team is building next for AI-native observability.",
    lastModified: SITE_CONTENT_LAST_MODIFIED,
  },
  {
    path: "/team",
    title: "Team | Superlog",
    description: "Meet the team building Superlog, the observability platform that fixes bugs.",
    lastModified: SITE_CONTENT_LAST_MODIFIED,
  },
  {
    path: "/privacy",
    title: "Privacy Policy | Superlog",
    description: "Read the Superlog privacy policy.",
    lastModified: SITE_CONTENT_LAST_MODIFIED,
  },
  {
    path: "/tos",
    title: "Terms of Service | Superlog",
    description: "Read the Superlog terms of service.",
    lastModified: SITE_CONTENT_LAST_MODIFIED,
  },
];

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function documentForPage(template: string, markup: string, page: PublicPage): string {
  const canonical = `${SITE_ORIGIN}${page.path === "/" ? "" : page.path}`;
  const image = `${SITE_ORIGIN}/og-image.png`;
  const metadata = [
    `<meta name="description" content="${escapeAttribute(page.description)}" />`,
    `<link rel="canonical" href="${escapeAttribute(canonical)}" />`,
    `<meta property="og:type" content="${page.ogType ?? "website"}" />`,
    `<meta property="og:site_name" content="Superlog" />`,
    '<meta property="og:locale" content="en_US" />',
    `<meta property="og:title" content="${escapeAttribute(page.title)}" />`,
    `<meta property="og:description" content="${escapeAttribute(page.description)}" />`,
    `<meta property="og:url" content="${escapeAttribute(canonical)}" />`,
    `<meta property="og:image" content="${image}" />`,
    '<meta property="og:image:type" content="image/png" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${SOCIAL_IMAGE_ALT}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeAttribute(page.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttribute(page.description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${SOCIAL_IMAGE_ALT}" />`,
    ...(page.publishedTime
      ? [`<meta property="article:published_time" content="${page.publishedTime}" />`]
      : []),
    ...(page.ogType === "article"
      ? [`<meta property="article:modified_time" content="${page.lastModified}" />`]
      : []),
    ...(page.author
      ? [`<meta property="article:author" content="${escapeAttribute(page.author)}" />`]
      : []),
    ...(page.structuredData
      ? [
          `<script type="application/ld+json">${JSON.stringify(page.structuredData).replaceAll("<", "\\u003c")}</script>`,
        ]
      : []),
  ].join("\n    ");

  return template
    .replace(/<title>.*?<\/title>/, `<title>${escapeAttribute(page.title)}</title>`)
    .replace("</head>", `    ${metadata}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
}

function outputPathForPage(path: string): string {
  return path === "/"
    ? resolve(process.cwd(), "dist/index.html")
    : resolve(process.cwd(), `dist${path}/index.html`);
}

async function prerender() {
  const templatePath = resolve(process.cwd(), "dist/index.html");
  const template = await readFile(templatePath, "utf8");

  const appShellPath = resolve(process.cwd(), "dist/app/index.html");
  const appShell = template
    .replace(/<title>.*?<\/title>/, "<title>Superlog App</title>")
    .replace("</head>", '    <meta name="robots" content="noindex, nofollow" />\n  </head>');
  await mkdir(resolve(appShellPath, ".."), { recursive: true });
  await writeFile(appShellPath, appShell);

  const notFound = template
    .replace(/<title>.*?<\/title>/, "<title>Page not found | Superlog</title>")
    .replace(/\s*<script type="module"[^>]*><\/script>/, "")
    .replace("</head>", '    <meta name="robots" content="noindex, nofollow" />\n  </head>')
    .replace(
      '<div id="root"></div>',
      '<div id="root"><main class="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6"><p class="text-sm text-muted">404</p><h1 class="mt-3 text-4xl text-fg">Page not found</h1><p class="mt-4 text-muted">The page you requested does not exist.</p><a class="mt-8 text-accent underline" href="/">Back to Superlog</a></main></div>',
    );
  await writeFile(resolve(process.cwd(), "dist/404.html"), notFound);

  for (const page of pages) {
    const markup = renderToString(
      <StaticRouter location={page.path}>
        <MarketingApp />
      </StaticRouter>,
    );
    const outputPath = outputPathForPage(page.path);
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, documentForPage(template, markup, page));
  }

  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map((page) => {
      const url = `${SITE_ORIGIN}${page.path === "/" ? "" : page.path}`;
      return `  <url><loc>${escapeAttribute(url)}</loc><lastmod>${page.lastModified}</lastmod></url>`;
    }),
    "</urlset>",
    "",
  ].join("\n");
  await writeFile(resolve(process.cwd(), "dist/sitemap.xml"), sitemap);
  await writeFile(
    resolve(process.cwd(), "dist/robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
  );

  const llms = [
    "# Superlog",
    "",
    "> AI-native observability that groups incidents, investigates production telemetry, and prepares fixes.",
    "",
    "## Website",
    "",
    ...pages.map((page) => {
      const url = `${SITE_ORIGIN}${page.path === "/" ? "" : page.path}`;
      const label = page.path === "/" ? "Home" : page.title.replace(/ \| Superlog$/, "");
      return `- [${label}](${url}): ${page.description}`;
    }),
    "",
    "## Documentation",
    "",
    "- [Documentation index](https://docs.superlog.sh/llms.txt)",
    "- [Complete documentation](https://docs.superlog.sh/llms-full.txt)",
    "",
    "## Open source",
    "",
    "- [Superlog on GitHub](https://github.com/superloglabs/superlog)",
    "",
  ].join("\n");
  await writeFile(resolve(process.cwd(), "dist/llms.txt"), llms);
}

void prerender();
