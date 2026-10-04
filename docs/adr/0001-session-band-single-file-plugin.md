---
status: accepted
date: 2026-10-04
decision-makers: Kiyoaki Tsurutani
---

# session-band ships as one plugin with one hooks module

## Context and Problem Statement

session-band grew out of two personal mods, a prompt cache countdown and a
session-stats band, each kept as its own plugin so it hot-reloads alone. For
distribution, how should the two be packaged, and how does the cache row
know the prompt cache TTL?

## Considered Options

- Publish the two mods as two plugins.
- Merge them into one plugin whose features live in separate files.
- Merge them into one plugin with a single hooks module.

## Decision Outcome

Chosen: one plugin, `plugins/session-band`, with one `hooks/register.tsx`.
One install gives the whole band, and its rows are ordered in one place.

Separate files inside one plugin were rejected because of two rules
`claude plugin validate` enforces: a plugin hooks an event once without a
matcher, and `$` reaches only functions declared in the same file. Shared
events such as `session.start` would need every feature's `$` code in the
one file that hooks them anyway.

The TTL is a `userConfig` option (`5m` or `1h`, default `5m`). The function
hooks API exposes the TTL only on model-switch hook inputs, so the plugin
cannot read it; defaulting to the shorter TTL errs toward showing the cache
as expired rather than warm.

### Consequences

- Good: one install, one `/config` section, one test suite.
- Bad: the module grows with each row; split into another plugin only when
  a feature no longer belongs in the band.
