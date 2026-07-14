import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type PullRequestTicketLinkTarget,
  linearTicketPrComment,
  linearTicketSlackReference,
  linkLinearTicketToPullRequestsWithDeps,
  pullRequestLinearComment,
} from "./linear-pr-linking.js";

const TICKET = {
  ticketId: "linear-uuid",
  identifier: "ENG-42",
  url: "https://linear.app/acme/issue/ENG-42",
  created: true,
};

const PRS: PullRequestTicketLinkTarget[] = [
  {
    id: "pr-row-1",
    installationId: 123,
    repoFullName: "acme/api",
    prNumber: 10,
    url: "https://github.com/acme/api/pull/10",
  },
  {
    id: "pr-row-2",
    installationId: 456,
    repoFullName: "acme/web",
    prNumber: 20,
    url: "https://github.com/acme/web/pull/20",
  },
];

test("Linear ticket PR comment contains a clickable ticket link", () => {
  assert.equal(
    linearTicketPrComment(TICKET),
    "Tracking this investigation in Linear: [ENG-42](https://linear.app/acme/issue/ENG-42)",
  );
});

test("Linear ticket Slack reference is clickable", () => {
  assert.equal(
    linearTicketSlackReference(TICKET),
    "Linear: <https://linear.app/acme/issue/ENG-42|ENG-42>",
  );
});

test("Linear receives a clickable pull request reference", () => {
  assert.equal(
    pullRequestLinearComment(PRS[0]!),
    "Pull request: [acme/api#10](https://github.com/acme/api/pull/10)",
  );
});

test("cross-links each pull request and the Linear ticket", async () => {
  const postedToGithub: PullRequestTicketLinkTarget[] = [];
  const postedToLinear: PullRequestTicketLinkTarget[] = [];
  const linked = await linkLinearTicketToPullRequestsWithDeps(TICKET, PRS, {
    claimGithub: async () => true,
    releaseGithub: async () => assert.fail("successful links must retain their claims"),
    postGithubComment: async (pr) => {
      postedToGithub.push(pr);
      return { ok: true };
    },
    claimLinear: async () => true,
    releaseLinear: async () => assert.fail("successful links must retain their claims"),
    postLinearComment: async (pr) => {
      postedToLinear.push(pr);
      return { ok: true };
    },
    log: () => {},
  });

  assert.deepEqual(linked, { linkedPullRequests: 2, complete: true });
  assert.deepEqual(postedToGithub, PRS);
  assert.deepEqual(postedToLinear, PRS);
});

test("does not post again when a pull request already has the ticket link", async () => {
  let posted = false;
  const linked = await linkLinearTicketToPullRequestsWithDeps(TICKET, PRS.slice(0, 1), {
    claimGithub: async () => false,
    releaseGithub: async () => {},
    postGithubComment: async () => {
      posted = true;
      return { ok: true };
    },
    claimLinear: async () => false,
    releaseLinear: async () => {},
    postLinearComment: async () => {
      posted = true;
      return { ok: true };
    },
    log: () => {},
  });

  assert.deepEqual(linked, { linkedPullRequests: 0, complete: true });
  assert.equal(posted, false);
});

test("releases a failed claim so a later sync can retry the comment", async () => {
  const released: string[] = [];
  const linked = await linkLinearTicketToPullRequestsWithDeps(TICKET, PRS.slice(0, 1), {
    claimGithub: async () => true,
    releaseGithub: async (pr, ticket) => {
      released.push(`${pr.id}:${ticket.ticketId}`);
    },
    postGithubComment: async () => ({ ok: false, error: "GitHub unavailable" }),
    claimLinear: async () => false,
    releaseLinear: async () => {},
    postLinearComment: async () => ({ ok: true }),
    log: () => {},
  });

  assert.deepEqual(linked, { linkedPullRequests: 0, complete: false });
  assert.deepEqual(released, ["pr-row-1:linear-uuid"]);
});
