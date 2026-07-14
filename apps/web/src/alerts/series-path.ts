export function alertSeriesPath(
  projectId: string | undefined,
  alertId: string | undefined,
  groupKey?: string,
): string {
  const qs = groupKey !== undefined ? `?groupKey=${encodeURIComponent(groupKey)}` : "";
  return `/api/projects/${projectId}/alerts/${alertId}/series${qs}`;
}
