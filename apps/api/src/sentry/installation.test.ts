import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sentryProjectIsAccessible } from "./client.js";

test("an OAuth install can select a Sentry project after the first cursor page", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (requested.length === 1) {
      return new Response(JSON.stringify([{ slug: "first-project" }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: '<https://sentry.io/api/0/organizations/acme/projects/?cursor=second>; rel="next"; results="true"',
        },
      });
    }
    return new Response(JSON.stringify([{ slug: "storefront" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const accessible = await sentryProjectIsAccessible({
    accessToken: "token",
    organizationSlug: "acme",
    projectSlug: "storefront",
    fetchImpl,
  });

  assert.equal(accessible, true);
  assert.deepEqual(requested, [
    "https://sentry.io/api/0/organizations/acme/projects/",
    "https://sentry.io/api/0/organizations/acme/projects/?cursor=second",
  ]);
});
