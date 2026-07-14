import { type ReactNode, useEffect, useRef } from "react";
import { type Me, useSetActiveContext } from "./api.ts";
import type { ProjectRouteSlugs } from "./project-route.ts";

export function ProjectRouteBoundary({
  children,
  me,
  slugs,
}: {
  children: ReactNode;
  me: Me | undefined;
  slugs: ProjectRouteSlugs;
}) {
  const setActiveContext = useSetActiveContext();
  const attempted = useRef<string | null>(null);
  const selected = me?.org?.slug === slugs.orgSlug && me.project?.slug === slugs.projectSlug;
  const target = `${slugs.orgSlug}/${slugs.projectSlug}`;

  useEffect(() => {
    if (!me || selected || attempted.current === target) return;
    attempted.current = target;
    setActiveContext.mutate(slugs, {
      // Reloading is intentional: org-scoped queries and Better Auth's session
      // store may both contain the previous tenant. The scoped URL survives the
      // reload, while every query starts cleanly in the selected context.
      onSuccess: () => window.location.reload(),
    });
  }, [me, selected, setActiveContext, slugs, target]);

  if (selected) return children;
  if (setActiveContext.error) {
    return (
      <main className="grid min-h-screen place-items-center bg-bg px-6 text-fg">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold">Project unavailable</h1>
          <p className="mt-2 text-[13px] text-muted">
            This project does not exist, or you do not have access to it.
          </p>
        </div>
      </main>
    );
  }
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-[13px] text-muted">
      Opening project…
    </main>
  );
}
