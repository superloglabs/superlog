import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Alert,
  AlertCreateBody,
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
