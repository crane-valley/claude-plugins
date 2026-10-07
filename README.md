# Crane Valley Claude Code plugins

A Claude Code plugin marketplace maintained by Crane Valley LLC.

## Install

```sh
claude plugin marketplace add crane-valley/claude-plugins
claude plugin install session-band@crane-valley
claude plugin install pr-review-cycle@crane-valley
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [session-band](plugins/session-band) | Prompt cache countdown, session cost, rate limits and context window usage in the band above the prompt |
| [pr-review-cycle](plugins/pr-review-cycle) | Takes a GitHub pull request through review: finds the active AI and human reviewers, answers every comment, waits for reviews to settle, and merges only when asked |

## Development

Each plugin lives in `plugins/<name>/`. Check one with:

```sh
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```

`claude plugin test` applies only to plugins with a hooks module (`hooks/hooks.json`); a skills-only plugin such as pr-review-cycle is checked with `claude plugin validate` alone.

A plugin's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json` and includes `.claude-plugin/types`; Claude Code writes `<plugin>/.claude-plugin/types/` (the engine's API declarations plus that `tsconfig.json`) whenever it loads the plugin from a local folder, e.g. `claude --plugin-dir plugins/<name>`, which works even without a login: the run exits "Not logged in" but the types are already written. After that, `npx -p typescript@5 tsc -p plugins/<name>` type-checks the plugin (CI does the same); the folder is git-ignored.

## Contact

Use GitHub Issues for bugs and requests. For anything that should not be public, email oss@crane-valley.co.jp; report security issues as described in [SECURITY.md](SECURITY.md).

## License

MIT
