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

export function useHomeDashboard(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["home-dashboard", projectId],
    queryFn: () => fetcher<DashboardWithWidgets>(`/api/projects/${projectId}/home`),
    enabled: !!projectId,
  });
}

export type AgentPullRequestSummary = {
  window: "30d";
  total: number;
  merged: number;
  unmerged: number;
  open: number;
  closed: number;
};

export function useAgentPullRequestSummary(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["home-pull-request-summary", projectId],
    queryFn: () =>
      fetcher<AgentPullRequestSummary>(`/api/projects/${projectId}/home/pull-request-summary`),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

export type HomeIncidentTrend = {
  active: number;
  rows: Array<{
    day: string;
    label: string;
    sev1: number;
    sev2: number;
    sev3: number;
    untriaged: number;
  }>;
};

export function useHomeIncidentTrend(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["home-incident-trend", projectId],
    queryFn: () => fetcher<HomeIncidentTrend>(`/api/projects/${projectId}/home/incident-trend`),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export type HomeSignalSeries = {
  step: string;
  rows: Array<{
    bucket: string;
    traces: number;
    logs: number;
    metrics: number;
  }>;
};

export function useHomeSignalSeries(
  projectId: string | undefined,
  range: { since: string; until: string },
) {
  const fetcher = useFetcher();
  const query = new URLSearchParams({ since: range.since, until: range.until });
  return useQuery({
    queryKey: ["home-signal-series", projectId, range.since, range.until],
    queryFn: () =>
      fetcher<HomeSignalSeries>(`/api/projects/${projectId}/home/signal-series?${query}`),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export type HomeBuiltinType =
  | "setup_todos"
  | "active_incidents"
  | "service_map"
  | "incoming_signals"
  | "incident_count"
  | "agent_pull_requests";

export function useSetHomeBuiltin(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, enabled }: { type: HomeBuiltinType; enabled: boolean }) =>
      fetcher<DashboardWithWidgets>(`/api/projects/${projectId}/home/builtins/${type}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (home) => qc.setQueryData(["home-dashboard", projectId], home),
  });
}

export function useCreateHomeWidget(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      type: WidgetType;
      title: string;
      config: WidgetConfig;
      layout: WidgetLayout;
    }) =>
      fetcher<Widget>(`/api/projects/${projectId}/home/widgets`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["home-dashboard", projectId] }),
  });
}

export function useCreateHomeLink(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; url: string; description?: string }) =>
      fetcher<Widget>(`/api/projects/${projectId}/home/links`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["home-dashboard", projectId] }),
  });
}

export function useDeleteHomeItem(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/home/items/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["home-dashboard", projectId] }),
  });
}

export function useUpdateHomeLayout(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (widgets: { id: string; layout: WidgetLayout }[]) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/home/layout`, {
        method: "PATCH",
        body: JSON.stringify({ widgets }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["home-dashboard", projectId] }),
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
