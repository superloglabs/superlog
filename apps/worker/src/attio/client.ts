import type { AttioValues } from "./domain.js";
import type { AttioClient, AttioRecordRef } from "./sync.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type AttioApiRecord = {
  id?: {
    record_id?: string;
  };
  values?: Record<string, unknown>;
};

type AttioApiResponse<T> = {
  data?: T;
};

const DEFAULT_ATTIO_API_BASE = "https://api.attio.com/v2";

function recordIdFromResponse(response: AttioApiResponse<AttioApiRecord>): string {
  const recordId = response.data?.id?.record_id;
  if (!recordId) throw new Error("Attio response did not include data.id.record_id");
  return recordId;
}

function firstTextValue(values: Record<string, unknown> | undefined, slug: string): string | null {
  const raw = values?.[slug];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first === "string") return first;
  if (!first || typeof first !== "object") return null;
  const object = first as Record<string, unknown>;
  if (typeof object.value === "string") return object.value;
  if (typeof object.text === "string") return object.text;
  return null;
}

export function createAttioRestClient(options: {
  apiKey: string;
  apiBase?: string;
  fetch?: FetchLike;
}): AttioClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("ATTIO_API_KEY is empty");
  const apiBase = (options.apiBase ?? DEFAULT_ATTIO_API_BASE).replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request<T>(path: string, init: RequestInit): Promise<AttioApiResponse<T>> {
    const response = await fetchImpl(`${apiBase}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Attio request failed: ${response.status} ${text.slice(0, 500)}`);
    }
    return (await response.json()) as AttioApiResponse<T>;
  }

  return {
    async listCompanyRecordsBySuperlogOrgId(): Promise<Map<string, string>> {
      const records = new Map<string, string>();
      const limit = 500;
      for (let offset = 0; ; offset += limit) {
        const response = await request<AttioApiRecord[]>("/objects/companies/records/query", {
          method: "POST",
          body: JSON.stringify({ limit, offset }),
        });
        const page = response.data ?? [];
        for (const record of page) {
          const orgId = firstTextValue(record.values, "superlog_org_id");
          const recordId = record.id?.record_id;
          if (!orgId || !recordId || records.has(orgId)) continue;
          records.set(orgId, recordId);
        }
        if (page.length < limit) break;
      }
      return records;
    },

    async createRecord(
      object: "companies" | "people",
      values: AttioValues,
    ): Promise<AttioRecordRef> {
      const response = await request<AttioApiRecord>(`/objects/${object}/records`, {
        method: "POST",
        body: JSON.stringify({ data: { values } }),
      });
      return { recordId: recordIdFromResponse(response) };
    },

    async updateRecordOverwrite(
      object: "companies" | "people",
      recordId: string,
      values: AttioValues,
    ): Promise<void> {
      await request<AttioApiRecord>(`/objects/${object}/records/${recordId}`, {
        method: "PUT",
        body: JSON.stringify({ data: { values } }),
      });
    },

    async upsertRecord(
      object: "companies" | "people",
      matchingAttribute: string,
      values: AttioValues,
    ): Promise<AttioRecordRef> {
      const params = new URLSearchParams({ matching_attribute: matchingAttribute });
      const response = await request<AttioApiRecord>(
        `/objects/${object}/records?${params.toString()}`,
        {
          method: "PUT",
          body: JSON.stringify({ data: { values } }),
        },
      );
      return { recordId: recordIdFromResponse(response) };
    },
  };
}
