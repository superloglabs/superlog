import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const distUrl = new URL("../dist/", import.meta.url);
const publicUrl = new URL("../public/", import.meta.url);

test("the social preview image has the declared PNG dimensions", async () => {
  const image = await readFile(new URL("og-image.png", publicUrl));

  assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
});

test("the production homepage contains useful HTML before JavaScript runs", async () => {
  const html = await readFile(new URL("index.html", distUrl), "utf8");

  assert.match(html, /<h1[^>]*>\s*Observability that fixes your bugs\s*<\/h1>/);
  assert.doesNotMatch(html, /<div id="root"><\/div>/);
  assert.match(html, /<meta property="og:type" content="website"/);
  assert.match(
    html,
    /<meta property="og:title" content="Superlog \| Observability that fixes your bugs"/,
  );
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(
    html,
    /<meta property="og:image" content="https:\/\/superlog\.sh\/og-image\.png"/,
  );
  assert.match(html, /<meta property="og:image:type" content="image\/png"/);
  assert.match(html, /<meta property="og:image:width" content="1200"/);
  assert.match(html, /<meta property="og:image:height" content="630"/);
  assert.match(html, /<meta property="og:locale" content="en_US"/);
  assert.match(
    html,
    /<meta property="og:image:alt" content="Superlog wordmark over a blue and violet abstract background"/,
  );
  assert.match(
    html,
    /<meta name="twitter:image:alt" content="Superlog wordmark over a blue and violet abstract background"/,
  );
  assert.match(html, /<script type="application\/ld\+json">[^<]*"@type":"Organization"/);
});

test("the homepage identifies the website and its publisher as the same organization", async () => {
  const html = await readFile(new URL("index.html", distUrl), "utf8");
  const match = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  assert.ok(match);

  const data = JSON.parse(match[1]) as {
    "@graph": Array<Record<string, unknown>>;
  };
  const organization = data["@graph"].find((entry) => entry["@type"] === "Organization");
  const website = data["@graph"].find((entry) => entry["@type"] === "WebSite");

  assert.equal(organization?.["@id"], "https://superlog.sh/#organization");
  assert.deepEqual(website?.publisher, { "@id": "https://superlog.sh/#organization" });
});

test("each public route has its own crawlable document and metadata", async () => {
  const html = await readFile(new URL("pricing/index.html", distUrl), "utf8");

  assert.match(html, /<h1[^>]*>Pricing<\/h1>/);
  assert.match(html, /<title>Pricing \| Superlog<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/superlog\.sh\/pricing"/);
});

test("the blog index and every published post are prerendered", async () => {
  const blogIndex = await readFile(new URL("blog/index.html", distUrl), "utf8");
  assert.match(blogIndex, /<h1[^>]*>Updates from the team<\/h1>/);

  const blogSourceUrl = new URL("../../../blog/", import.meta.url);
  const postFiles = (await readdir(blogSourceUrl)).filter((file) => file.endsWith(".md"));
  assert.ok(postFiles.length > 0);

  for (const file of postFiles) {
    const slug = file.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    const html = await readFile(new URL(`blog/${slug}/index.html`, distUrl), "utf8");
    assert.match(html, /<article|<h1/);
    assert.match(
      html,
      new RegExp(`<link rel="canonical" href="https://superlog\\.sh/blog/${slug}"`),
    );
    assert.match(html, /<meta property="og:type" content="article"/);
    assert.match(html, /<meta property="article:modified_time" content="\d{4}-\d{2}-\d{2}"/);
    assert.match(html, /<script type="application\/ld\+json">[^<]*"@type":"BlogPosting"/);
  }
});

test("published articles describe their image, author, freshness, and breadcrumbs", async () => {
  const html = await readFile(
    new URL("blog/quieter-incidents-slack-and-connectors/index.html", distUrl),
    "utf8",
  );
  const match = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  assert.ok(match);

  const data = JSON.parse(match[1]) as { "@graph": Array<Record<string, unknown>> };
  const article = data["@graph"].find((entry) => entry["@type"] === "BlogPosting");
  const breadcrumbs = data["@graph"].find((entry) => entry["@type"] === "BreadcrumbList");

  assert.equal(article?.image, "https://superlog.sh/og-image.png");
  assert.equal(article?.dateModified, "2026-07-10");
  assert.deepEqual(article?.author, {
    "@type": "Person",
    name: "Arseniy",
    url: "https://superlog.sh/team",
  });
  assert.equal(
    (article?.publisher as { logo?: { url?: string } } | undefined)?.logo?.url,
    "https://superlog.sh/web-app-manifest-512x512.png",
  );
  assert.ok(breadcrumbs);
});

test("every public content route ships as an indexable static document", async () => {
  const routes = ["changelog", "roadmap", "team", "privacy", "tos"];

  for (const route of routes) {
    const html = await readFile(new URL(`${route}/index.html`, distUrl), "utf8");
    assert.doesNotMatch(html, /<div id="root"><\/div>/);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://superlog\\.sh/${route}"`));
    assert.match(html, /<meta name="description" content="[^"]+"/);
  }
});

test("the product SPA has a dedicated noindex shell under /app", async () => {
  const html = await readFile(new URL("app/index.html", distUrl), "utf8");

  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(html, /<title>Superlog App<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.doesNotMatch(html, /rel="canonical"/);
});

test("unknown routes receive a static noindex 404 document", async () => {
  const html = await readFile(new URL("404.html", distUrl), "utf8");

  assert.match(html, /<title>Page not found \| Superlog<\/title>/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(html, /<h1[^>]*>Page not found<\/h1>/);
});

test("crawlers receive a sitemap of public pages and no product URLs", async () => {
  const sitemap = await readFile(new URL("sitemap.xml", distUrl), "utf8");
  const robots = await readFile(new URL("robots.txt", distUrl), "utf8");

  assert.match(sitemap, /<loc>https:\/\/superlog\.sh<\/loc>/);
  assert.match(
    sitemap,
    /<loc>https:\/\/superlog\.sh<\/loc><lastmod>2026-07-22<\/lastmod>/,
  );
  assert.match(sitemap, /<loc>https:\/\/superlog\.sh\/pricing<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/superlog\.sh\/blog\//);
  assert.doesNotMatch(sitemap, /\/app(?:\/|<)/);
  assert.match(robots, /Sitemap: https:\/\/superlog\.sh\/sitemap\.xml/);
});

test("AI readers receive a concise index of public pages and full documentation", async () => {
  const llms = await readFile(new URL("llms.txt", distUrl), "utf8");

  assert.match(llms, /^# Superlog$/m);
  assert.match(llms, /\[Pricing\]\(https:\/\/superlog\.sh\/pricing\)/);
  assert.match(llms, /https:\/\/docs\.superlog\.sh\/llms\.txt/);
  assert.doesNotMatch(llms, /https:\/\/superlog\.sh\/app(?:\/|\s|\))/);
});
