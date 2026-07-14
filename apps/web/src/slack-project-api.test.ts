import { strict as assert } from "node:assert";
import { test } from "node:test";
import { slackProjectEndpoints } from "./api.js";

test("Slack project endpoints keep every settings request in the selected project", () => {
  assert.deepEqual(slackProjectEndpoints("project-2"), {
    installation: "/api/projects/project-2/slack/installation",
    installUrl: "/api/projects/project-2/slack/install-url",
    uninstall: "/api/projects/project-2/slack/uninstall",
    channels: "/api/projects/project-2/slack/channels",
  });
});
