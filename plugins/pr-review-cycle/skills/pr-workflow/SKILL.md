---
name: pr-workflow
description: |
  GitHub pull request lifecycle: create the PR, wait for and work through
  the reviews the repository actually has (AI review bots, human reviewers,
  or none), fix failed checks, and merge only when merging was asked for.
  Use it whenever working a PR, and when delegating PR work to subagents.
  Triggers: "create PR", "push and create PR", "handle review comments",
  "check PR status", "merge PR", "review cycle", "wait for reviews",
  "fix PR comments", "CI failed", "fix checks".
compatibility: Requires GitHub CLI (gh), authenticated for the repository
allowed-tools: Bash(gh *), Bash(git *), Bash(sleep *)
---

# PR Workflow

## Scope Contract

Do what was asked, and stop where it says:

- "create a PR" -- create it, run the first review round, and report.
- "handle PR N", "work this PR through review" -- run the review cycle until
  the PR is ready to merge, then report. Do not merge.
- "merge it", "take it through to merge", or project instructions (CLAUDE.md,
  AGENTS.md, CONTRIBUTING.md) that tell the agent to merge its own PRs once
  review settles -- run the review cycle and merge on the Merge gate below.

Merging is a separate authorization from reviewing. Never merge because the
review cycle came out clean unless one of the sources above authorized it,
and never continue past a stopping point the user stated (create-only,
no-merge, no-cleanup). Never silently downgrade a full run to inspection.

Before any edit: `gh auth status` succeeds, you are on the PR's feature
branch (not the default branch), and no unrelated local changes would be
swept into a commit.

## Discover the Review Setup

Repositories differ: some have one or more AI review bots, some have human
reviewers or required approvals, some have neither. Establish the setup from
live state for each PR. Never assume a bot or a reviewer exists because
another project has one.

### AI review bots

The active bot set is the bot accounts that have reviewed or commented on
this PR, plus those that did so on recent PRs in this repository:

```bash
# Bot reviewers on the last 10 closed PRs (adjust OWNER/REPO)
for n in $(gh pr list --state closed --limit 10 --json number --jq '.[].number'); do
  gh api "repos/OWNER/REPO/pulls/$n/reviews" --paginate --jq '.[].user | select(.type == "Bot") | .login'
  gh api "repos/OWNER/REPO/issues/$n/comments" --paginate --jq '.[].user | select(.type == "Bot") | .login'
done | sort | uniq -c
```

Ignore bots that only post CI, coverage, or deployment notices; count the
ones that review code. Logins carry a `[bot]` suffix in the REST API. Only
a bot in the active set is waited for or re-requested. An empty result from
the history check means unknown, not none: a bot enabled recently has no
history yet. Take the first wait anyway, then settle the set from the
current PR. If it is still empty after that wait, the project has no AI
review: judge the PR on checks and human review state alone.

Known behaviour, applied only to bots in the active set (verify against what
the bot actually does here):

- Copilot (`copilot-pull-request-reviewer`): reviews on PR creation when the
  repository enables it and re-reviews on push. Never re-request it.
- Codex (`chatgpt-codex-connector`): reviews on PR creation and decides by
  itself whether a later push needs a review. Never re-request it and never
  mention it in a comment (any mention triggers it). No Codex review on a new
  head after a full wait is its verdict that none is needed: it is settled
  for that head, not outstanding. A clean Codex review may be only a
  thumbs-up reaction on the PR description or a short "no major issues"
  comment naming the reviewed commit.
- Gemini Code Assist (`gemini-code-assist`): reviews on PR creation only.
  After each fix push, re-request it with a comment whose body is exactly
  `/gemini review`.

For any other bot, read its own comments (most explain their triggers) and
follow them; when unsure, do not re-request.

### Human reviewers

```bash
gh pr view N --json reviewDecision,reviewRequests,latestReviews,mergeStateStatus
gh api repos/OWNER/REPO/branches/BASE/protection --jq '.required_pull_request_reviews'
gh api repos/OWNER/REPO/rules/branches/BASE --paginate --jq '.[] | select(.type == "pull_request")'
```

A human gate exists when `reviewDecision` is `REVIEW_REQUIRED`, a person
whose review in `latestReviews` is `CHANGES_REQUESTED` has not yet
approved (a bot's change request is handled like its other findings), a
person or a team is in `reviewRequests`, branch protection or a
ruleset requires approving reviews or code-owner review, a person has an
unresolved thread on the PR, or the project's instructions say a person
reviews every PR. The protection endpoint returns 404 when the branch is
unprotected or you lack admin access, so read the ruleset endpoint and
`reviewDecision` before concluding there is no gate.

You cannot approve your own PR or stand in for a required reviewer. When a
human gate exists:

- Handle human comments exactly like bot comments (triage, fix, reply), but
  do not resolve a thread a person opened unless the project's convention is
  that the author resolves; reply and leave it for them.
- Once the AI side is settled, report that the PR waits on human review and
  stop. Do not poll for a person with timed waits.

## Creating PRs

1. Confirm you are on a feature branch: `git branch --show-current`.
2. Run the project's checks (lint, type-check, tests).
3. Self-review the diff. If the project's instructions require another
   review before pushing, run it. Update any plan or changelog file the
   project's instructions require, on this branch, so it lands with the PR.
4. Push: `git push -u origin <branch>`.
5. Create: `gh pr create --head <branch>`, or `--head <owner>:<branch>`
   when the branch was pushed to a fork (follow the repository's PR
   template if it has one).
6. Do not request reviews from bots; those configured for the repository
   start on PR creation.
7. Start the wake-up timer even when the bot discovery found nothing (see
   above): run `sleep 600` in the
   background (in Claude Code, the Bash tool with run_in_background), then
   end the turn with a one-line status. Bots take 5-10 minutes; the finished
   background command wakes you. Never run a long foreground sleep. When the
   PR turns out to have no AI review, also wait for the checks
   (`gh pr checks N --watch` in the background), then apply the human gate.
   Right after creation the checks
   may not be registered yet and `--watch` exits at once; re-run it until
   the expected checks appear, and treat "no checks" as clean only once you
   have established that the repository runs none on pull requests.

## Review Cycle

Bots post new comments after each push, so merging without waiting risks
missing feedback still in progress.

```
PR created -> background sleep 600 -> wake -> read state
  |
  |- no actionable findings -> 1st clean read -> background sleep 600 -> 2nd read
  |                              |- unchanged -> ready (merge only if authorized)
  |                              +- changed  -> triage, back into the cycle
  |
  +- P0-P2 findings -> fix -> push -> re-request only bots that need it
                        -> background sleep 600 -> wake -> read state
```

"Clean" means two consecutive clean reads separated by a real wait, never
one. Nothing enforces the second read; take it.

### Round 1 (after PR creation)

1. Wait as in Creating PRs step 7, then read the state.
2. Settle the active bot set from what you now see.
3. Triage every comment P0-P3 with the scale in the `check-pr-comments`
   skill (its Triage step defines it; do not invent a second scale).
4. No findings, or only P3: reply briefly to each P3 thread (acknowledge, or
   state the disagreement). Resolve it if a bot opened it; a thread a person
   opened follows the human-review rule above and stays for them. Re-fetch
   and judge that read against the Review Settling Window. Acknowledged P3
   does not block; a read with open bot P3 threads does not count.
5. Findings in review bodies or issue comments (bots often put them there
   instead of in a thread) have no thread to reply to: after triage, post
   one PR comment stating each finding and its disposition, then fetch it
   back to confirm it exists. Do this in every round, not only before a
   merge.
6. Valid findings outside the PR's scope: file an issue, or record them
   where the project's instructions say; do not grow the PR.

### Round N (fix cycle)

1. Fix P0-P2 findings, run checks, commit, push.
2. Reply to and resolve each thread with `check-pr-comments`, and answer
   review-body and issue-comment findings as in Round 1 step 5.
3. Re-request only the active bots whose known behaviour needs it (above).
4. Background `sleep 600`, end the turn.
5. A bot that stays silent through a full wait after a push it would have
   reviewed is inactive for this head. Silence is a pass, never a reason to
   re-request.
6. Repeat until no new findings or only P3 remain, then take the Review
   Settling Window's two reads.

### Review Settling Window

Green checks and zero unresolved threads do not prove review has settled:
reviewers publish after CI finishes and after an earlier empty read.

1. Note the time just before a push and again once `headRefOid` shows the new
   head. Reviews carry `commit_id`; compare it to the head. Issue comments
   carry none, so a commit-less comment counts as completion evidence only
   when its body names the current commit. Anything else, and anything
   inside the push window, is unknown. Timestamps only retire positive
   evidence; an untriaged finding is never discarded for being old.
2. After posting a re-request comment, fetch it back and check its body is
   what you meant (not an unexpanded shell variable, not an older commit).
   If it is malformed, post a corrected one and restart the wait.
3. Both reads must show: the same head commit, required checks finished and
   passing, zero untriaged findings (threads, review bodies and issue
   comments), zero unresolved threads, and no active bot outstanding. A bot is
   outstanding when it reviewed an earlier head and has neither reviewed the
   current head nor stayed silent through a full wait since the push. Take the
   second read on another background `sleep 600` wake-up.
4. Any change in head, checks, reviews, comments, or threads made by a
   reviewer or CI resets the window: triage first, then wait again. Your own
   replies do not reset it.

When the window closes clean and no human gate is open, the PR is ready.
Report it, or merge if merging was authorized (Scope Contract).

## Merge Gate

Check live state right before merging:

1. Required checks passed: `gh pr checks N`.
2. Zero unresolved review threads, from your own full read of every thread
   (resolved ones included, since a reviewer can reply on a resolved
   thread), comparing comment ids and `updatedAt`/`lastEditedAt` with the
   previous read so edits are noticed.
3. No actionable finding left in review bodies or issue comments. Bots often
   put findings there instead of in a thread:
   ```bash
   gh api repos/OWNER/REPO/pulls/N/reviews --paginate
   gh api repos/OWNER/REPO/issues/N/comments --paginate
   ```
   Each must already have its disposition comment (Round 1 step 5).
4. No human gate open: no condition under Human reviewers holds.
   `reviewDecision` is `APPROVED`, empty, or `CHANGES_REQUESTED` only from a
   bot whose findings are all handled.
5. The head is still the commit you checked:
   `gh pr view N --json headRefOid` matches local `HEAD`. Keep that SHA for
   the merge command.
6. The PR is open and mergeable: `gh pr view N --json state,mergeable,mergeStateStatus`.
7. Use the repository's merge method. Read which are allowed
   (`gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`)
   and follow the project's convention or recent history; do not assume
   squash.
8. Merge bound to that SHA, so a push after your checks makes the merge
   fail instead of merging unreviewed code, for example
   `gh pr merge N --squash --match-head-commit <sha>`.
9. Confirm the result: `gh pr view N --json state`. On a branch with a
   merge queue the command only queues the PR; it is merged when `state` is
   `MERGED`. Report a queued PR as queued, and do not clean up until it has
   merged.

### Late Reviews

A review that arrives after the merge still gets handled: check the finding
against the merged code, open a follow-up PR or issue if it is valid, and
record the disposition where the finding lives (reply and resolve a thread;
for a review body or issue comment, a PR comment). Lengthen the wait on the
next PR to the latency you observed. Handle the PR in front of you; do not
sweep old PRs.

## Failed Checks

Fix CI failures, push, then return to the review cycle.

0. Check merge status first: `gh pr view N --json mergeable,mergeStateStatus`.
   - `CONFLICTING`: `pull_request` workflows do not run at all, which looks
     like CI not triggering. Merge or rebase the base branch, resolve, push.
   - `UNKNOWN`: GitHub is still computing; re-check shortly.
1. Failed checks and links:
   `gh pr checks N --json name,state,bucket,link --jq '.[] | select(.bucket == "fail" or .bucket == "cancel")'`
   A cancelled check blocks like a failed one: find why it was cancelled
   (a superseded run, a timeout, a manual cancel) and re-run it
   (`gh run rerun <run-id>`) or fix the cause.
2. Logs:
   - Head commit: `gh pr view N --json headRefOid -q .headRefOid`
   - Runs: `gh run list --commit <sha> --limit 10`
   - Failing jobs: `gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion != "success") | {name, conclusion}'`
   - `gh run view <run-id> --log-failed`
   - A check with no Actions run is external CI; open its link.
3. Reproduce locally where possible, fix the root cause, commit, push, and
   confirm the checks re-run.

## After the Merge

Once `gh pr view N --json state` shows `MERGED` (not merely queued), and
unless the user asked to keep the branch: switch off the merged branch, update the default branch, delete the local
branch, and remove the git worktree only if one was created for this PR.
`gh pr merge --delete-branch` may fail on the local side when the branch is
checked out in a worktree; delete the remote branch separately in that case
unless the repository deletes merged branches automatically.

## Delegating to Subagents

- Pass every review comment's file, line, body and author in the prompt.
- Require the project's checks before committing.
- The review cycle still applies after the subagent pushes.
- The subagent uses `check-pr-comments` for replies and resolves.

## GitHub API Notes

The commands in both skills are written for Bash; on Windows run them
through Git Bash. The PowerShell notes below are for reading JSON in
PowerShell when you must.

- Use `--paginate` (or `per_page=100`); the default page of 30 misses
  comments on busy PRs.
- GraphQL: page `reviewThreads` until its own `pageInfo.hasNextPage` is
  false.
- `gh api graphql --paginate` follows the first key named `pageInfo` in the
  response at any depth, so alias every nested connection's `pageInfo`. A
  thread with more than 100 comments needs a second query by thread id.
- With `--paginate --slurp`, flatten the page arrays into items before
  counting, and treat an empty result or a count mismatch as unknown review
  state, never as zero findings.
- Prefer `gh ... --jq` for filtering; a standalone `jq` may not be installed.
- Windows, Git Bash: prefix `MSYS_NO_PATHCONV=1` to a gh command whose
  argument starts with `/` (such as `/gemini review`), or Git Bash rewrites it
  into a file path. PowerShell does not need this.
- Windows, PowerShell 7+: parse paginated JSON with
  `ConvertFrom-Json -NoEnumerate` and walk pages and items in two loops;
  pipeline enumeration can treat a whole page as one record. Windows
  PowerShell 5.1 has no `-NoEnumerate`; assign `$pages = ConvertFrom-Json
  $json` without `@(...)`, which would collapse the pages. Bash is simpler.
- The `check-pr-comments` skill ships the GraphQL documents for the
  reply-and-resolve path.

## Review Conduct

When you write review comments yourself:

- Prefix severity so authors can prioritize: `Nit:`, `Optional:`, `FYI:`.
- Do not accept "will clean it up in a follow-up" without an issue filed
  before merge.
- Keep large refactors (renames, moves, reformatting) out of feature and
  bug-fix PRs.

Background: Google's Engineering Practices,
https://google.github.io/eng-practices/review/
