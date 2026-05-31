import { postSlackMessage } from "../infra/slack/api.js";
import {
  buildProposalSlackBlocks,
  buildProposalSlackText,
  type ProposalToolInput,
} from "./domain.js";

// Mockable Slack interface used by the autorecovery use case. Production
// wiring delegates to the shared infra/slack/api.ts helpers (which handle
// bot-token revocation), tests substitute a recording fake.
export type SlackPoster = {
  postProposal(input: {
    installationId: string;
    botAccessToken: string;
    channelId: string;
    threadTs: string;
    proposalId: string;
    proposal: ProposalToolInput;
  }): Promise<SlackPostResult>;
};

export type SlackPostResult = { ok: true; ts: string } | { ok: false; error: string };

export function createSlackPoster(): SlackPoster {
  return {
    async postProposal(input) {
      const data = await postSlackMessage({
        target: {
          installationId: input.installationId,
          channelId: input.channelId,
          botToken: input.botAccessToken,
        },
        text: buildProposalSlackText(input.proposal),
        blocks: buildProposalSlackBlocks(input.proposalId, input.proposal),
        threadTs: input.threadTs,
      });
      if (!data) return { ok: false, error: "network_error" };
      if (data.ok && data.ts) return { ok: true, ts: data.ts };
      return { ok: false, error: data.error ?? "unknown" };
    },
  };
}
