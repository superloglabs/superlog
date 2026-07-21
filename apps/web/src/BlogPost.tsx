import { useParams } from "react-router-dom";
import { getBlogPost } from "./blogPosts.ts";
import { Markdown } from "./content/Markdown.tsx";
import { PublicShell } from "./content/PublicShell.tsx";
import { formatBlogDate } from "./content/formatBlogDate.ts";

export function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getBlogPost(slug) : undefined;

  if (!post) {
    return (
      <PublicShell eyebrow="Blog" title="Post not found">
        <p className="text-[15px] text-muted">
          We couldn't find that post.{" "}
          <a href="/blog" className="text-accent underline underline-offset-4">
            Back to the blog
          </a>
          .
        </p>
      </PublicShell>
    );
  }

  const byline = [post.author, formatBlogDate(post.date)].filter(Boolean).join(" · ");

  return (
    <PublicShell eyebrow="Blog" title={post.title} subtitle={byline || undefined}>
      <div className="max-w-[720px]">
        <Markdown text={post.body} />
        <div className="mt-14 border-t border-border pt-8">
          <a
            href="/blog"
            className="text-[13px] font-medium text-accent underline-offset-4 hover:underline"
          >
            ← All posts
          </a>
        </div>
      </div>
    </PublicShell>
  );
}
