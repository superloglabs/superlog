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
  structuredData?: Record<string, unknown>;
};

const SITE_ORIGIN = "https://superlog.sh";
const pages: PublicPage[] = [
  {
    path: "/",
    title: "Superlog | Observability that fixes your bugs",
    description:
      "AI-native observability that groups incidents, investigates production telemetry, and prepares fixes.",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Superlog",
      url: SITE_ORIGIN,
      logo: `${SITE_ORIGIN}/superlog-pictogram-dark.svg`,
      sameAs: ["https://github.com/superloglabs/superlog"],
    },
  },
  {
    path: "/pricing",
    title: "Pricing | Superlog",
    description:
      "Start with free OpenTelemetry ingest and pay only for the telemetry and investigations your team uses.",
  },
  {
    path: "/blog",
    title: "Blog | Superlog",
    description: "Product updates, engineering notes, and lessons from building Superlog.",
  },
  ...BLOG_POSTS.map((post) => ({
    path: `/blog/${post.slug}`,
    title: `${post.title} | Superlog`,
    description: post.excerpt || `Read ${post.title} on the Superlog blog.`,
    ogType: "article" as const,
    publishedTime: post.date,
    author: post.author,
    structuredData: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.excerpt || `Read ${post.title} on the Superlog blog.`,
      datePublished: post.date,
      author: { "@type": "Person", name: post.author || "Superlog" },
      publisher: {
        "@type": "Organization",
        name: "Superlog",
        logo: { "@type": "ImageObject", url: `${SITE_ORIGIN}/superlog-pictogram-dark.svg` },
      },
      mainEntityOfPage: `${SITE_ORIGIN}/blog/${post.slug}`,
    },
  })),
  {
    path: "/changelog",
    title: "Changelog | Superlog",
    description:
      "See the latest product improvements, fixes, and integrations shipped by Superlog.",
  },
  {
    path: "/roadmap",
    title: "Roadmap | Superlog",
    description: "See what the Superlog team is building next for AI-native observability.",
  },
  {
    path: "/team",
    title: "Team | Superlog",
    description: "Meet the team building Superlog, the observability platform that fixes bugs.",
  },
  {
    path: "/privacy",
    title: "Privacy Policy | Superlog",
    description: "Read the Superlog privacy policy.",
  },
  {
    path: "/tos",
    title: "Terms of Service | Superlog",
    description: "Read the Superlog terms of service.",
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
    `<meta property="og:title" content="${escapeAttribute(page.title)}" />`,
    `<meta property="og:description" content="${escapeAttribute(page.description)}" />`,
    `<meta property="og:url" content="${escapeAttribute(canonical)}" />`,
    `<meta property="og:image" content="${image}" />`,
    '<meta property="og:image:type" content="image/png" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta property="og:image:alt" content="Superlog" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeAttribute(page.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttribute(page.description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    '<meta name="twitter:image:alt" content="Superlog" />',
    ...(page.publishedTime
      ? [`<meta property="article:published_time" content="${page.publishedTime}" />`]
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
      return `  <url><loc>${escapeAttribute(url)}</loc></url>`;
    }),
    "</urlset>",
    "",
  ].join("\n");
  await writeFile(resolve(process.cwd(), "dist/sitemap.xml"), sitemap);
  await writeFile(
    resolve(process.cwd(), "dist/robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
  );
}

void prerender();
