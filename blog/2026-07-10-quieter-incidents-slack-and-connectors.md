---
title: Quieter incidents, an agent that listens, and one-click connectors
date: 2026-07-10
author: Arseniy
excerpt: A short update on what we shipped this week — less trigger-happy PRs, a chat composer and memories on the incident view, talking to Superlog on Slack, four new integrations, and a batch of agent improvements.
---

Hi there,

This is Arseniy from Superlog. Nico and I wanted to give you a short update of
what we've shipped to the app this week.

Here are the major themes.

## Less noisy PRs and incidents

The most common feedback we got was "Superlog is a bit too trigger-happy with
PRs." So we gave the agent more ways to respond than opening one.

- Instead of removing error lines from code, the agent can now **silence**
  issues. This is reserved for errors that are clear false positives — for
  example, error logs on 404s on the landing page.
- The agent can also place issues **under observation** with an escalation
  trigger. It does this for cases where the app *did* log an error, but nothing
  really broke. One Superlog client said that GDPR-deleted users sometimes have a
  tail of 401 Unauthorized errors from their mobile sessions. Superlog will now
  place these under observation, swallowing short bursts, but will investigate if
  they cross the reoccurrence threshold.
- We added a **resolved** state for errors and alert episodes. The agent can pick
  this when the impact has stopped (for example, the error was fixed elsewhere).
  Any new reoccurrence triggers a fresh investigation.
- We completely reworked the agent tools. Previously the agent had to decide on
  one terminal state for the entire incident — resolve as already fixed, resolve
  as noise, or open a PR. Now it can choose **silence**, **resolve**, or **under
  observation** for every issue independently.

## An agent that listens to your feedback and records memories

- We added a chat composer to the incident view so you can ask the agent to
  change things in your PR, remember important facts, and clarify things.
- **[beta]** You can now reply to Slack threads and GitHub PRs — the agent can
  take the same follow-up actions.
- You can leave 👍 / 👎 feedback on Slack incident threads. This feedback powers a
  self-improving loop for the Superlog agent (though for now we review these
  entries manually to prevent slop).

## Talking to Superlog on Slack

You can tag **@superlog** on Slack to:

- ask it to investigate things ("why is error rate so high on this service?")
- do support ("Alex says checkout doesn't work")
- and anything else that needs access to your codebase and telemetry.

## Cloudflare, Render, Vercel, and Railway integrations

Our first priority was letting you hook up services in one click (or, at worst,
several). Next week we'll focus on GCP and Azure to cover most runtime infra
providers.

## Many improvements to the agent

- The agent can now open **multiple PRs** and see them through to completion.
- The agent gets a single **alert episode** — a contiguous period of threshold
  breach — to investigate, so it doesn't have to fetch the alert and figure out
  which failure to look at.
- The agent reads **CLAUDE.md / AGENTS.md** and Cursor rules from your repo.

We love your feedback, so let us know if the above is helpful and if we can add
more. If you have any thoughts, just reply to this email — we read all
responses.

Thank you very much for being a Superlog user. I really appreciate having you
around.

Yours,

— ash
