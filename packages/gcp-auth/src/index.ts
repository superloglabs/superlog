import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { AwsClient } from "google-auth-library";

export type AwsRuntimeCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type AwsRuntimeCredentialProvider = () => Promise<AwsRuntimeCredentials>;

export function createAwsFederatedGcpClient(
  serializedConfig: string,
  input: {
    region?: string;
    credentialProvider?: AwsRuntimeCredentialProvider;
  } = {},
): AwsClient {
  const parsed = JSON.parse(serializedConfig) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || parsed.type !== "external_account") {
    throw new Error("GCP workload identity config must be an external-account object");
  }
  const region = input.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("AWS_REGION is required for GCP workload identity federation");
  const credentialProvider = input.credentialProvider ?? defaultProvider();
  const { credential_source: _legacyCredentialSource, ...config } = parsed;
  const audience = requiredString(config, "audience");
  const subjectTokenType = requiredString(config, "subject_token_type");

  return new AwsClient({
    ...config,
    audience,
    subject_token_type: subjectTokenType,
    aws_security_credentials_supplier: {
      async getAwsRegion() {
        return region;
      },
      async getAwsSecurityCredentials() {
        const credentials = await credentialProvider();
        return {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          ...(credentials.sessionToken ? { token: credentials.sessionToken } : {}),
        };
      },
    },
  });
}

function requiredString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`GCP workload identity config is missing ${key}`);
  }
  return value;
}
