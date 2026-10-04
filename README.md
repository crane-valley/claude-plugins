# Crane Valley Claude Code plugins

A Claude Code plugin marketplace maintained by Crane Valley LLC.

## Install

```sh
claude plugin marketplace add crane-valley/claude-plugins
claude plugin install session-band@crane-valley
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [session-band](plugins/session-band) | Prompt cache countdown, session cost, rate limits and context window usage in the band above the prompt |

## Development

Each plugin lives in `plugins/<name>/`. Check one with:

```sh
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```

For editor types, run `/plugin-types plugins/<name>/.claude/types` in a Claude Code session; the folder is git-ignored.

## Contact

Use GitHub Issues for bugs and requests. For anything that should not be public, email oss@crane-valley.co.jp; report security issues as described in [SECURITY.md](SECURITY.md).

## License

MIT
