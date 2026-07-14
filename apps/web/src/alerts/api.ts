import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { alertSeriesPath } from "./series-path.ts";
import type {
  Alert,
  AlertCreateBody,
  AlertEpisode,
  AlertPreviewSeries,
  AlertTestResult,
  AlertWithFirings,
} from "./types.ts";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100";

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

export function useAlerts(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["alerts", projectId],
    queryFn: () => fetcher<Alert[]>(`/api/projects/${projectId}/alerts`),
    enabled: !!projectId,
  });
}

export function useAlert(projectId: string | undefined, id: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["alert", projectId, id],
    queryFn: () => fetcher<AlertWithFirings>(`/api/projects/${projectId}/alerts/${id}`),
    enabled: !!projectId && !!id,
  });
}

export function useAlertEpisodes(projectId: string | undefined, id: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["alert-episodes", projectId, id],
    queryFn: () => fetcher<AlertEpisode[]>(`/api/projects/${projectId}/alerts/${id}/episodes`),
    enabled: !!projectId && !!id,
  });
}

// The evaluated-signal series (with threshold) for a *saved* alert, keyed by
// alert id. Used by the incident timeline to draw the alert's metric-vs-threshold
// graph on the triggering issue card. `enabled` lets callers defer the fetch
// until the card is actually an alert.
export function useAlertSeries(
  projectId: string | undefined,
  alertId: string | undefined,
  options: { enabled?: boolean; groupKey?: string | null } = {},
) {
  const fetcher = useFetcher();
  const groupKey = options.groupKey ?? undefined;
  return useQuery({
    queryKey: ["alert-series", projectId, alertId, groupKey ?? null],
    queryFn: () => fetcher<AlertPreviewSeries>(alertSeriesPath(projectId, alertId, groupKey)),
    enabled: !!projectId && !!alertId && options.enabled !== false,
  });
}

export function useCreateAlert(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AlertCreateBody) =>
      fetcher<Alert>(`/api/projects/${projectId}/alerts`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts", projectId] }),
  });
}

export function useUpdateAlert(projectId: string, id: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<AlertCreateBody>) =>
      fetcher<Alert>(`/api/projects/${projectId}/alerts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts", projectId] });
      qc.invalidateQueries({ queryKey: ["alert", projectId, id] });
    },
  });
}

export function useDeleteAlert(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/alerts/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts", projectId] }),
  });
}

export function usePreviewAlert(projectId: string) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (body: AlertCreateBody) =>
      fetcher<AlertTestResult>(`/api/projects/${projectId}/alerts/preview`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

export function usePreviewAlertSeries(projectId: string) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (body: AlertCreateBody) =>
      fetcher<AlertPreviewSeries>(`/api/projects/${projectId}/alerts/preview-series`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}
