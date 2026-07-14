import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardSummary,
  DashboardVariable,
  DashboardWithWidgets,
  Widget,
  WidgetConfig,
  WidgetLayout,
  WidgetType,
} from "./types.ts";

const API_URL = import.meta.env?.VITE_API_URL ?? "http://localhost:4100";

function useFetcher() {
  return async function fetcher<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.headers ?? {}),
        "content-type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  };
}

export function useDashboards(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["dashboards", projectId],
    queryFn: () => fetcher<DashboardSummary[]>(`/api/projects/${projectId}/dashboards`),
    enabled: !!projectId,
  });
}

export function useDashboard(projectId: string | undefined, id: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["dashboard", projectId, id],
    queryFn: () => fetcher<DashboardWithWidgets>(`/api/projects/${projectId}/dashboards/${id}`),
    enabled: !!projectId && !!id,
  });
}

export function useCreateDashboard(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      fetcher<DashboardSummary>(`/api/projects/${projectId}/dashboards`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboards", projectId] }),
  });
}

export function useDeleteDashboard(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/dashboards/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboards", projectId] }),
  });
}

export function useRenameDashboard(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      fetcher<DashboardSummary>(`/api/projects/${projectId}/dashboards/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["dashboards", projectId] });
      qc.invalidateQueries({ queryKey: ["dashboard", projectId, vars.id] });
    },
  });
}

export function useSetVariables(projectId: string, dashboardId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    // The dashboard PATCH route accepts name + an optional variables list; we
    // send both so the rename schema is satisfied while replacing variables.
    mutationFn: ({ name, variables }: { name: string; variables: DashboardVariable[] }) =>
      fetcher<DashboardSummary>(`/api/projects/${projectId}/dashboards/${dashboardId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, variables }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", projectId, dashboardId] });
      qc.invalidateQueries({ queryKey: ["dashboards", projectId] });
    },
  });
}

export function useCreateWidget(projectId: string, dashboardId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      type: WidgetType;
      title: string;
      config: WidgetConfig;
      layout: WidgetLayout;
    }) =>
      fetcher<Widget>(`/api/projects/${projectId}/dashboards/${dashboardId}/widgets`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", projectId, dashboardId] }),
  });
}

export function useUpdateWidget(projectId: string, dashboardId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      type?: WidgetType;
      title?: string;
      config?: WidgetConfig;
      layout?: WidgetLayout;
    }) =>
      fetcher<Widget>(`/api/projects/${projectId}/dashboards/${dashboardId}/widgets/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", projectId, dashboardId] }),
  });
}

export function useDeleteWidget(projectId: string, dashboardId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/dashboards/${dashboardId}/widgets/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", projectId, dashboardId] }),
  });
}

export function useUpdateLayout(projectId: string, dashboardId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (widgets: { id: string; layout: WidgetLayout }[]) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/dashboards/${dashboardId}/layout`, {
        method: "PATCH",
        body: JSON.stringify({ widgets }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", projectId, dashboardId] }),
  });
}
