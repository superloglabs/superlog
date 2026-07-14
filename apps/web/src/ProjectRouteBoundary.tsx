import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { type Me, useSetActiveContext } from "./api.ts";
import { Btn } from "./design/ui.tsx";
import { projectRouteFailureKind } from "./project-route-failure.ts";
import type { ProjectRouteSlugs } from "./project-route.ts";

export function ProjectRouteFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const unavailable = projectRouteFailureKind(error) === "unavailable";
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-fg">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold">
          {unavailable ? "Project unavailable" : "Couldn’t open project"}
        </h1>
        <p className="mt-2 text-[13px] text-muted">
          {unavailable
            ? "This project does not exist, or you do not have access to it."
            : "Something went wrong while switching projects. Please try again."}
        </p>
        {!unavailable && (
          <Btn className="mt-4" onClick={onRetry}>
            Retry
          </Btn>
        )}
      </div>
    </main>
  );
}

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
  const mutateActiveContext = setActiveContext.mutate;

  const openProject = useCallback(() => {
    attempted.current = target;
    mutateActiveContext({ orgSlug: slugs.orgSlug, projectSlug: slugs.projectSlug }, {
      // Reloading is intentional: org-scoped queries and Better Auth's session
      // store may both contain the previous tenant. The scoped URL survives the
      // reload, while every query starts cleanly in the selected context.
      onSuccess: () => window.location.reload(),
    });
  }, [mutateActiveContext, slugs.orgSlug, slugs.projectSlug, target]);

  useEffect(() => {
    if (!me || selected || attempted.current === target) return;
    openProject();
  }, [me, openProject, selected, target]);

  if (selected) return children;
  if (setActiveContext.error) {
    return <ProjectRouteFailure error={setActiveContext.error} onRetry={openProject} />;
  }
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-[13px] text-muted">
      Opening project…
    </main>
  );
}
