import { OrgOverviewTable } from "../../Admin.tsx";
import type { AdminOrgOverviewRow } from "../../api.ts";

const mockRows: AdminOrgOverviewRow[] = [
  {
    org: {
      id: "1",
      name: "Acme Corp",
      slug: "acme",
      createdAt: "2026-04-01T00:00:00Z",
      signupSource: "skill",
    },
    githubConnected: true,
    githubConnectedAt: "2026-04-02T14:12:00Z",
    slackConnected: true,
    slackConnectedAt: "2026-04-05T09:30:00Z",
    mcpConnected: true,
    mcpConnectedAt: "2026-04-07T11:45:00Z",
    members: [
      { userId: "u-ceo@acme.test", email: "ceo@acme.test", name: null, joinedAt: "2026-04-01T08:00:00Z" },
      { userId: "u-cto@acme.test", email: "cto@acme.test", name: null, joinedAt: "2026-04-01T09:15:00Z" },
      { userId: "u-platform-lead@acme.test", email: "platform-lead@acme.test", name: null, joinedAt: "2026-04-03T13:40:00Z" },
    ],
    thisWeek: { traces: 12400, incidents: 8, prsOpened: 14, prsMerged: 11 },
    prevWeek: { traces: 9800, incidents: 11, prsOpened: 9, prsMerged: 7 },
  },
  {
    org: {
      id: "2",
      name: "Beta Labs",
      slug: "beta-labs",
      createdAt: "2026-04-15T00:00:00Z",
      signupSource: "skill",
    },
    githubConnected: true,
    githubConnectedAt: "2026-04-15T16:20:00Z",
    slackConnected: false,
    slackConnectedAt: null,
    mcpConnected: true,
    mcpConnectedAt: "2026-04-20T08:10:00Z",
    members: [
      { userId: "u-founder@beta.test", email: "founder@beta.test", name: null, joinedAt: "2026-04-15T10:00:00Z" },
      { userId: "u-eng1@beta.test", email: "eng1@beta.test", name: null, joinedAt: "2026-04-16T11:30:00Z" },
    ],
    thisWeek: { traces: 3200, incidents: 2, prsOpened: 4, prsMerged: 3 },
    prevWeek: { traces: 1100, incidents: 0, prsOpened: 1, prsMerged: 1 },
  },
  {
    org: {
      id: "3",
      name: "Gamma Industries",
      slug: "gamma",
      createdAt: "2026-04-22T00:00:00Z",
      signupSource: "web",
    },
    githubConnected: false,
    githubConnectedAt: null,
    slackConnected: true,
    slackConnectedAt: "2026-04-23T10:00:00Z",
    mcpConnected: false,
    mcpConnectedAt: null,
    members: [{ userId: "u-ops@gamma.test", email: "ops@gamma.test", name: null, joinedAt: "2026-04-22T14:00:00Z" }],
    thisWeek: { traces: 0, incidents: 0, prsOpened: 0, prsMerged: 0 },
    prevWeek: { traces: 0, incidents: 0, prsOpened: 0, prsMerged: 0 },
  },
  {
    org: {
      id: "4",
      name: "Delta Health",
      slug: "delta-health",
      createdAt: "2026-05-01T00:00:00Z",
      signupSource: null,
    },
    githubConnected: false,
    githubConnectedAt: null,
    slackConnected: false,
    slackConnectedAt: null,
    mcpConnected: false,
    mcpConnectedAt: null,
    members: [],
    thisWeek: { traces: 0, incidents: 0, prsOpened: 0, prsMerged: 0 },
    prevWeek: { traces: 0, incidents: 0, prsOpened: 0, prsMerged: 0 },
  },
  {
    org: {
      id: "5",
      name: "Epsilon AI",
      slug: "epsilon",
      createdAt: "2026-05-05T00:00:00Z",
      signupSource: "skill",
    },
    githubConnected: true,
    githubConnectedAt: "2026-05-05T12:00:00Z",
    slackConnected: true,
    slackConnectedAt: "2026-05-06T15:30:00Z",
    mcpConnected: false,
    mcpConnectedAt: null,
    members: [
      { userId: "u-alice@epsilon.ai", email: "alice@epsilon.ai", name: null, joinedAt: "2026-05-05T09:00:00Z" },
      { userId: "u-bob@epsilon.ai", email: "bob@epsilon.ai", name: null, joinedAt: "2026-05-05T09:05:00Z" },
      { userId: "u-carol@epsilon.ai", email: "carol@epsilon.ai", name: null, joinedAt: "2026-05-06T16:00:00Z" },
      { userId: "u-dave@epsilon.ai", email: "dave@epsilon.ai", name: null, joinedAt: "2026-05-07T08:30:00Z" },
    ],
    thisWeek: { traces: 1_200_000, incidents: 23, prsOpened: 6, prsMerged: 4 },
    prevWeek: { traces: 980_000, incidents: 19, prsOpened: 5, prsMerged: 5 },
  },
];

export function AdminOverviewPlayground() {
  return (
    <div className="min-h-screen bg-bg p-8">
      <OrgOverviewTable rows={mockRows} />
    </div>
  );
}
