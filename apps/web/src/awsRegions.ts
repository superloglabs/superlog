// Canonical commercial AWS region list, shared by the settings stream-config
// picker and the onboarding "Connect AWS" picker so the two never drift. Keep
// this aligned with the API's region guard (`/^[a-z0-9-]{1,32}$/` in
// cloud-connections.ts) — every code here must satisfy it.
export const AWS_REGIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "us-east-1", name: "US East (N. Virginia)" },
  { code: "us-east-2", name: "US East (Ohio)" },
  { code: "us-west-1", name: "US West (N. California)" },
  { code: "us-west-2", name: "US West (Oregon)" },
  { code: "ca-central-1", name: "Canada (Central)" },
  { code: "ca-west-1", name: "Canada West (Calgary)" },
  { code: "eu-west-1", name: "Europe (Ireland)" },
  { code: "eu-west-2", name: "Europe (London)" },
  { code: "eu-west-3", name: "Europe (Paris)" },
  { code: "eu-central-1", name: "Europe (Frankfurt)" },
  { code: "eu-central-2", name: "Europe (Zurich)" },
  { code: "eu-north-1", name: "Europe (Stockholm)" },
  { code: "eu-south-1", name: "Europe (Milan)" },
  { code: "eu-south-2", name: "Europe (Spain)" },
  { code: "ap-south-1", name: "Asia Pacific (Mumbai)" },
  { code: "ap-south-2", name: "Asia Pacific (Hyderabad)" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)" },
  { code: "ap-southeast-2", name: "Asia Pacific (Sydney)" },
  { code: "ap-southeast-3", name: "Asia Pacific (Jakarta)" },
  { code: "ap-southeast-4", name: "Asia Pacific (Melbourne)" },
  { code: "ap-southeast-5", name: "Asia Pacific (Malaysia)" },
  { code: "ap-southeast-7", name: "Asia Pacific (Thailand)" },
  { code: "ap-northeast-1", name: "Asia Pacific (Tokyo)" },
  { code: "ap-northeast-2", name: "Asia Pacific (Seoul)" },
  { code: "ap-northeast-3", name: "Asia Pacific (Osaka)" },
  { code: "ap-east-1", name: "Asia Pacific (Hong Kong)" },
  { code: "ap-east-2", name: "Asia Pacific (Taipei)" },
  { code: "sa-east-1", name: "South America (São Paulo)" },
  { code: "mx-central-1", name: "Mexico (Central)" },
  { code: "me-south-1", name: "Middle East (Bahrain)" },
  { code: "me-central-1", name: "Middle East (UAE)" },
  { code: "il-central-1", name: "Israel (Tel Aviv)" },
  { code: "af-south-1", name: "Africa (Cape Town)" },
];

export const AWS_REGION_CODES: readonly string[] = AWS_REGIONS.map((r) => r.code);

export const DEFAULT_AWS_REGION = "us-east-1";
