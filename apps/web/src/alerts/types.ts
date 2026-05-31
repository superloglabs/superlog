export type AlertSource = "logs" | "traces" | "metric";
export type AlertAggregation = "count" | "sum" | "avg";
export type AlertComparator = "gt" | "lt";
export type AlertGroupMode = "per_group" | "single";

export type AlertFilter = {
  resourceAttrs?: { key: string; value: string }[];
  service?: string;
  severity?: string;
  spanName?: string;
  statusCode?: string;
  minDurationMs?: number;
};

export type Alert = {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  source: AlertSource;
  metricName: string | null;
  filter: AlertFilter;
  groupBy: string | null;
  groupMode: AlertGroupMode;
  aggregation: AlertAggregation;
  comparator: AlertComparator;
  threshold: number;
  windowMinutes: number;
  evaluationIntervalSeconds: number;
  createdBy: string;
  lastEvaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AlertFiring = {
  id: string;
  alertId: string;
  groupKey: string;
  state: "firing" | "ok";
  observedValue: number;
  evaluatedAt: string;
  issueId: string | null;
};

export type AlertWithFirings = Alert & { firings: AlertFiring[] };

export type AlertCreateBody = {
  name: string;
  enabled?: boolean;
  source: AlertSource;
  metricName?: string | null;
  filter?: AlertFilter;
  groupBy?: string | null;
  groupMode?: AlertGroupMode;
  aggregation: AlertAggregation;
  comparator: AlertComparator;
  threshold: number;
  windowMinutes?: number;
  evaluationIntervalSeconds?: number;
};

export type AlertTestResult =
  | {
      mode: "single";
      value: number;
      breaches: number;
    }
  | {
      mode: "per_group";
      groups: { key: string; value: number; breaching: boolean }[];
      breaches: number;
    };
