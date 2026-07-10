import { Link } from "react-router-dom";
import { BLOG_POSTS } from "./blogPosts.ts";
import { PublicShell } from "./content/PublicShell.tsx";
import { formatBlogDate } from "./content/formatBlogDate.ts";

export function Blog() {
  return (
    <PublicShell
      eyebrow="Blog"
      title="Updates from the team"
      subtitle="Product updates, notes, and what we're thinking about. Newest first."
    >
      {BLOG_POSTS.length === 0 ? (
        <p className="text-[15px] text-muted">No posts yet — check back soon.</p>
      ) : (
        <div className="space-y-12">
          {BLOG_POSTS.map((post) => (
            <article
              key={post.slug}
              className="grid gap-4 border-t border-border pt-8 first:border-t-0 first:pt-0 md:grid-cols-[160px_1fr]"
            >
              <div className="flex flex-col gap-1">
                <time className="text-[13px] font-medium text-subtle">
                  {formatBlogDate(post.date)}
                </time>
                {post.author && <span className="text-[13px] text-muted">{post.author}</span>}
              </div>
              <div className="min-w-0">
                <h2 className="text-[20px] font-semibold tracking-tight text-fg">
                  <Link to={`/blog/${post.slug}`} className="transition-colors hover:text-accent">
                    {post.title}
                  </Link>
                </h2>
                {post.excerpt && (
                  <p className="mt-3 text-[15px] leading-7 text-muted">{post.excerpt}</p>
                )}
                <Link
                  to={`/blog/${post.slug}`}
                  className="mt-4 inline-block text-[13px] font-medium text-accent underline-offset-4 hover:underline"
                >
                  Read more →
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </PublicShell>
  );
}
