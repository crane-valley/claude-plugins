---
name: check-pr-comments
description: |
  Handle GitHub PR review comments end-to-end: fetch every thread, triage
  P0-P3, fix, reply, verify each reply, resolve, and re-check. Defines the
  P0-P3 scale the pr-workflow skill uses; use it even for a single comment.
  Triggers: "PR comments", "review comments", "resolve comments",
  "address review".
compatibility: Requires GitHub CLI (gh), authenticated for the repository
allowed-tools: Bash(gh *), Bash(git *), PowerShell(gh *), PowerShell(git *), Read
---

Handle review comments on PR #$ARGUMENTS.

## Scope Contract

Run the whole workflow below, from fetch through the Step 7 re-check, unless
the user stated a stopping point. Merging is not part of this skill.

Before any edit: `gh auth status` succeeds, the checked-out branch is the PR's
head branch, and no unrelated local changes would be swept into a commit.

## GraphQL Documents

The five GraphQL documents this workflow needs ship next to this file, in
`queries/`:

- `queries/fetch-threads.graphql` -- paginated thread fetch (Step 1)
- `queries/fetch-thread-comments.graphql` -- all comments on one thread (Step 1b)
- `queries/reply-thread.graphql` -- `addPullRequestReviewThreadReply` (Step 4)
- `queries/verify-reply.graphql` -- read a reply back by node ID (Step 6)
- `queries/resolve-thread.graphql` -- `resolveReviewThread` (Step 6)

Pass them with `-F query=@<path>`. Do not inline a document as
`-f query='...$var...'`: shells can expand the GraphQL variables (`$owner`,
`$threadId`) before gh sees them.

`SKILL` below is this skill's base directory, the folder this SKILL.md was
loaded from (Claude Code states it when the skill loads). Shell state may
not persist between tool calls, so set it in the same command as each gh call:

```bash
SKILL="<this skill's base directory>"
```

## Step 1: Fetch All Threads

```bash
# gh does not expand {owner}/{repo} inside GraphQL -F values
read OWNER REPO < <(gh repo view --json owner,name --jq '.owner.login + " " + .name')

gh api graphql --paginate \
  -F owner="$OWNER" -F name="$REPO" -F pr=N \
  -F query=@"$SKILL/queries/fetch-threads.graphql" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved == false)
        | {id, viewerCanReply, viewerCanResolve,
           comments: [.comments.nodes[] | {author: .author.login, path, line, body}]}
          + (if .comments.commentsPageInfo.hasNextPage
             then {truncated: true, commentsCursor: .comments.commentsPageInfo.endCursor}
             else {} end)'
```

Filter with gh's built-in `--jq`; a standalone `jq` may not be installed.
To inspect the raw payload, drop `--jq`, add `--slurp` (without it,
`--paginate` prints one JSON document per page), and write it to a file.

`isOutdated` flags threads whose line has changed since, `resolvedBy` shows
who resolved a thread, `startLine`/`diffSide` locate multi-line and
deletion-side comments, and `headRefOid` is the PR head commit, kept for
Step 6.

## Step 1b: Complete Any Truncated Thread

A thread with more than 100 comments comes back with `truncated: true` and a
`commentsCursor`. Never triage it from the partial list; the newest comments
are at the end. Fetch the rest and merge it into that thread first:

```bash
gh api graphql --paginate \
  -F threadId='THREAD_NODE_ID' \
  -F endCursor='COMMENTS_CURSOR_FROM_STEP_1' \
  -F query=@"$SKILL/queries/fetch-thread-comments.graphql" \
  --jq '.data.node.comments.nodes[] | {author: .author.login, path, line, body}'
```

This is a separate document because `gh api graphql --paginate` drives one
connection per document, and `fetch-threads.graphql` spends it on
`reviewThreads` (see the alias comment in that file).

If the fetch fails, warn by thread rather than triaging silently, and repeat
the limitation in your reply on that thread:

```
WARNING: thread PRRT_xxx truncated at 100 comments -- later comments unread
```

## Step 2: Triage

The scale used by this skill and by `pr-workflow`:

- P0 -- Blocker: bug, security flaw, data loss risk -- fix immediately
- P1 -- Important: logic error, missing edge case, bad pattern -- fix before merge
- P2 -- Improvement: style, naming, minor refactor -- fix if cost is low
- P3 -- Nitpick: preference, cosmetic -- acknowledge or fix

Check each claim against the code before acting on it; reviewers, bots
especially, are sometimes wrong. Low-severity comments still deserve an
honest answer, and a small fix beats a dismissal.

Note who opened each thread: a bot or a person. Both get the same triage and
reply; they differ only at resolve time (Step 6).

## Step 3: Fix

Address findings in priority order, run the project's checks, and commit
only when they pass.

## Step 4: Reply to Every Thread

```bash
gh api graphql \
  -F threadId='THREAD_NODE_ID' \
  -f body='Fixed in abc1234 -- the cache is now keyed by tenant.' \
  -F query=@"$SKILL/queries/reply-thread.graphql" \
  --jq '.data.addPullRequestReviewThreadReply.comment.id'
```

Use `-f` (not `-F`) for `body` so values like `true`, `null` or `@file` are
sent as text. Check `viewerCanReply` from Step 1 first. A non-empty comment
ID in the output means the reply exists; empty output means it does not (see
Step 5).

Every reply states the disposition and its basis: what changed and where,
why it is deferred, or the technical reason for not changing it.

If a reviewer did not understand the code, prefer making the code clearer
(rename, restructure, or a comment explaining why) over explaining in the
thread; the next reader of the file will have the same question.

When you disagree, give the tradeoff you weighed and why the alternative
looks worse, and ask which axis the reviewer wants moved.

## Step 5: Verify Every Reply

A gh call can fail without visible output, so a reply you think you posted
may not exist.

- Single-quote the body. In double quotes, backticks become command
  substitution and `$names` expand, corrupting the request.
- The `--jq` output must be a non-empty ID; otherwise retry with a fixed body.
- Never pipe gh output through `head` or `tail`; truncation hides the error.

## Step 6: Confirm, Then Resolve

Check each reply ID exists on the server:

```bash
gh api graphql \
  -F id='PRRC_xxx' \
  -F query=@"$SKILL/queries/verify-reply.graphql" \
  --jq '.data.node.id'
```

For a thread that needed a code fix, the fix must be on the PR head before
you resolve it. After pushing, `git rev-parse HEAD` must equal
`gh pr view N --json headRefOid --jq .headRefOid`.

Then resolve:

```bash
for tid in THREAD_ID_1 THREAD_ID_2; do
  gh api graphql \
    -F threadId="$tid" \
    -F query=@"$SKILL/queries/resolve-thread.graphql" \
    --jq '.data.resolveReviewThread.thread.isResolved'
done
```

- Check `viewerCanResolve` first; without it the mutation fails.
- Never resolve a thread without a reply.
- Bot threads: resolve after replying.
- Threads a person opened: follow the project's convention. Where it is not
  stated, reply and leave the thread for the reviewer to resolve.

## Step 7: Re-fetch

Read every thread again, resolved ones included: a reviewer can reply on a
thread after it was resolved, and the Step 1 filter would hide that reply.
Run the Step 1 command with this `--jq` instead, and compare the comment ids
with what you have already handled:

```bash
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | {id, isResolved,
           comments: [.comments.nodes[] | {id, author: .author.login, body}]}'
```

A comment you have not seen is new, wherever it sits; triage it, and reopen
the discussion with a reply if it lands on a resolved thread. Every thread
you handled must be resolved or (for a person's thread left open by
convention) answered, and no new unanswered comment may remain. If new ones
appeared, triage them in this same run. Stop only when what is left is
excluded by the user, blocked by permissions, or waiting on a reviewer's
answer.

When called from `pr-workflow`, return only after this check is clean, so
the review cycle can go on waiting for reviewers.
