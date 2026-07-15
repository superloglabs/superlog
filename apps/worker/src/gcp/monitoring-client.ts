import type { GcpMonitoringReader, GcpTimeSeries } from "./metrics-puller.js";

export class GoogleMonitoringClient implements GcpMonitoringReader {
  constructor(
    private readonly deps: {
      integrationProjectId: string;
      accessToken: () => Promise<string>;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async listTimeSeries(input: {
    gcpProjectId: string;
    metricType: string;
    startTime: Date;
    endTime: Date;
    pageSize: number;
    pageToken?: string;
  }): Promise<{ timeSeries: GcpTimeSeries[]; nextPageToken?: string }> {
    const url = new URL(
      `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(input.gcpProjectId)}/timeSeries`,
    );
    url.searchParams.set("filter", `metric.type = ${JSON.stringify(input.metricType)}`);
    url.searchParams.set("interval.startTime", input.startTime.toISOString());
    url.searchParams.set("interval.endTime", input.endTime.toISOString());
    url.searchParams.set("view", "FULL");
    url.searchParams.set("pageSize", String(input.pageSize));
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);

    const response = await (this.deps.fetchImpl ?? fetch)(url, {
      headers: {
        authorization: `Bearer ${await this.deps.accessToken()}`,
        "x-goog-user-project": this.deps.integrationProjectId,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Monitoring read failed (${response.status}): ${text.slice(0, 500)}`);
    }
    const body = (await response.json()) as {
      timeSeries?: GcpTimeSeries[];
      nextPageToken?: string;
    };
    return {
      timeSeries: body.timeSeries ?? [],
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }
}
