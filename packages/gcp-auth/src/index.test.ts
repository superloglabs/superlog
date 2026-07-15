import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createAwsFederatedGcpClient } from "./index.js";

test("AWS federation uses the supplied ECS-aware credential provider instead of EC2 metadata", async () => {
  let providerCalls = 0;
  const client = createAwsFederatedGcpClient(
    JSON.stringify({
      type: "external_account",
      audience:
        "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/aws",
      subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/runtime@example.iam.gserviceaccount.com:generateAccessToken",
      credential_source: {
        environment_id: "aws1",
        region_url: "http://169.254.169.254/latest/meta-data/placement/availability-zone",
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials",
        regional_cred_verification_url:
          "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15",
      },
    }),
    {
      region: "us-west-2",
      credentialProvider: async () => {
        providerCalls += 1;
        return {
          accessKeyId: "AKIATEST",
          secretAccessKey: "test-secret",
          sessionToken: "test-session",
        };
      },
    },
  );

  const subjectToken = JSON.parse(decodeURIComponent(await client.retrieveSubjectToken())) as {
    headers: Array<{ key: string; value: string }>;
  };
  assert.equal(providerCalls, 1);
  assert.ok(subjectToken.headers.some((header) => header.key === "x-amz-security-token"));
});
