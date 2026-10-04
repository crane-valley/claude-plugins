---
status: accepted
date: 2026-10-04
decision-makers: Kiyoaki Tsurutani
---

# pr-review-cycle is a skills-only plugin that observes each repository's reviewers

## Context and Problem Statement

pr-review-cycle publishes a personal pull request workflow: a lifecycle skill
(create, wait, triage, fix checks, merge) and a review-thread skill (fetch,
triage, reply, verify, resolve) with its GraphQL documents. The personal
version assumed one setup: three AI review bots on every repository, no
human reviewers, merging as soon as review settled, and local helpers (a
plan file, a second-opinion review tool, a worktree cleanup hook for a
bare-clone layout). Other projects differ in all of these.

## Considered Options

- Skills only, with reviewers discovered from live GitHub state and merging
  driven by the user's request or the project's instructions.
- Skills plus a `userConfig` merge switch and a configured bot list.
- Skills plus hooks that enforce the workflow (for example, blocking a
  re-request to a bot that decides for itself).

## Decision Outcome

Chosen: skills only.

- Reviewers are observed, not configured. The active bot set is the bots
  that reviewed this PR or recent PRs in the same repository; only those are
  waited for. Notes on Copilot, Codex and Gemini apply only when that bot is
  active. An empty set means the repository has no AI review.
- Human review is read from `reviewDecision`, requested reviewers, branch
  protection and rulesets, open threads by people, and project instructions.
  The agent cannot approve its own PR, so with a human gate it reports and
  stops instead of polling.
- Merging needs its own authorization: the user's request or the project's
  instructions. A clean review cycle alone ends at "ready to merge".

A `userConfig` switch was rejected because whether skill text can read
option values is not established for skills, and the request and project
instructions already carry the intent per repository. A configured bot list
goes stale and is wrong for a repository the user did not configure. Hooks
were rejected for this release: a guard tuned to one bot's trigger settings
is personal policy, and the skills already say not to re-request.

Removed from the personal version: the plan-file convention, the
second-opinion review tool, the bare-clone worktree layout and its cleanup
hook, local file paths, and notes about local guard hooks. Kept: the
Windows notes for Git Bash and PowerShell, labelled as such.

### Consequences

- Good: works on a repository with any mix of AI bots, human reviewers, or
  neither, without setup.
- Good: no hooks module, so nothing runs unless a skill is invoked.
- Bad: the reviewer discovery costs a few API calls per PR.
- `claude plugin test` fails on a plugin with no hooks module, so CI runs it
  only for plugins that have `hooks/hooks.json`.
- Whether the author's own configuration switches from its local skills to
  this plugin is left to that repository; the local skills carry personal
  extras this one cannot.
