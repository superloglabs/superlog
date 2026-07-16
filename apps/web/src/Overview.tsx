import { useMe } from "./api.ts";
import { HomeDashboard } from "./home/HomeDashboard.tsx";

export function Overview() {
  const me = useMe();

  if (me.isLoading) {
    return <div className="text-[12px] text-muted">Loading…</div>;
  }
  if (me.error) {
    return <div className="text-[12px] text-danger">Error: {String(me.error)}</div>;
  }
  if (!me.data || !me.data.org || !me.data.project) return null;

  return (
    <HomeDashboard
      projectId={me.data.project.id}
      slugs={{ orgSlug: me.data.org.slug, projectSlug: me.data.project.slug }}
    />
  );
}
