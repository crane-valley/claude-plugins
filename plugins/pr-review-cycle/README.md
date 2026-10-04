# pr-review-cycle

`pr-review-cycle` is a skills-only Claude Code plugin (version 0.1.0) by Crane Valley LLC under the MIT license. It contains no hooks and no MCP servers, providing two skills:

- `pr-workflow`: the PR lifecycle -- create the PR, wait for reviews, work through findings, fix failed CI checks, and merge only when merging was asked for. Triggers on phrases like "create PR", "handle review comments", "check PR status", "merge PR", "wait for reviews", "CI failed".
- `check-pr-comments`: handles review threads end to end -- fetch every thread (paginated, including threads with over 100 comments), triage P0 (blocker) to P3 (nitpick), fix, reply to every thread, verify each reply really exists on the server, resolve, and re-fetch for comments that arrived meanwhile. Ships five GraphQL documents it uses with `gh api graphql`.

Findings outside the scope of the PR are filed as issues (or recorded where project instructions say) rather than added to the PR.

## Requirements

- GitHub CLI `gh`, authenticated with access to the repository.
- Bash. The commands are written for Bash; on Windows they run through Git Bash.
- Claude Code background commands are used for waiting.

## Install

```sh
claude plugin marketplace add crane-valley/claude-plugins
claude plugin install pr-review-cycle@crane-valley
```

## Usage

You can invoke the skills directly as `/pr-review-cycle:pr-workflow` and `/pr-review-cycle:check-pr-comments`, or Claude Code can run them automatically when a request matches.

Example requests:

- "create PR"
- "handle review comments"
- "handle PR 123"
- "check PR status"
- "wait for reviews"
- "CI failed"
- "merge it"

## When it merges

The plugin never merges just because review came out clean.

- A request to "create a PR" creates the PR, runs the first review round, and reports.
- A request to "handle PR N" runs the review cycle until ready, then reports without merging.
- It merges only when the user asked for a merge ("merge it", "take it through to merge") or the project's own instructions (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`) tell the agent to merge its own PRs once review settles.

It uses the repository's allowed merge method and convention, not a fixed squash.

After a merge (only when merging was authorized), the plugin deletes the local branch and removes a git worktree only if one was created for the PR.

## Reviewers (AI bots and human review)

### Reviewer discovery

The plugin assumes no reviewer. For each PR it determines from live GitHub state which AI review bots are active: bot accounts that reviewed or commented on this PR or on recent closed PRs in the same repository. Only those are waited for. If none, it judges the PR on CI and human review state alone.

### AI review bots

Built-in knowledge of three bots, applied only when that bot is active in the repo:

| Bot | Behavior | Re-request action |
| --- | --- | --- |
| GitHub Copilot | Re-reviews on push | Never re-requested |
| ChatGPT Codex connector | Decides by itself whether a push needs review; silence after a wait counts as done | Never re-requested or mentioned |
| Gemini Code Assist | Reviews on PR creation | Re-requested with `/gemini review` after each fix push |

For other bots, the plugin follows what their own comments say about triggers; when unsure, it does not re-request.

### Human review

It reads `reviewDecision`, requested reviewers, branch protection and rulesets (required approvals, code owners), open threads by people, and project instructions. It cannot approve its own PR.

When a human gate exists:

- It answers human comments like bot comments, but leaves threads a person opened for that person to resolve (unless the project says otherwise).
- Once the AI side settles, it reports that the PR waits on human review and stops; it does not poll for people.

## Waiting and settling

After a push it waits about 10 minutes with a background `sleep 600`, then rereads state.

A PR counts as settled only after two consecutive clean reads separated by a real wait:

- Same head commit
- Checks passed
- No untriaged findings in threads, review bodies or issue comments
- No unresolved threads
- No active bot outstanding

Any reviewer or CI change resets it.

## Limitations

- GitHub only (not GitLab etc.).
- Bot behavior notes reflect how those bots behaved when written and may change; the plugin trusts what it observes in the repository over the notes.
- Waiting costs wall-clock time (10 minutes per round).
- It cannot satisfy required human approvals.

## Contact

Report issues on [GitHub Issues](https://github.com/crane-valley/claude-plugins/issues). Security issues are handled as described in [SECURITY.md](../../SECURITY.md) at the repository root.

## License

MIT
