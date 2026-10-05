---
status: accepted
date: 2026-10-05
decision-makers: Kiyoaki Tsurutani
---

# session-band reads usage credits from the usage endpoint, polled through stored state

## Context and Problem Statement

Plans billed in usage credits (Enterprise seats, for one) report no rate-limit
window on responses, so the band's Limits row stayed empty there. Monthly credit
spend in Claude Code's `/usage` under "Usage credits" comes only from
`https://api.anthropic.com/api/oauth/usage` (field `extra_usage`: `is_enabled`,
`utilization`), an undocumented endpoint. `$.http.fetch` has no timeout and
cannot be cancelled.

## Considered Options

- A module-level in-flight flag guarding the request.
- The stored reading as the lock, written with compare-and-set.
- Staleness keyed on the last answer's time.

## Decision Outcome

Chosen: an opt-in `showCredits` option that polls the usage endpoint with the
claude.ai login, with the stored reading as the lock and staleness keyed on
`pendingSince`.

The `userConfig` option `showCredits` (default `false`) is opt-in because the
endpoint is undocumented and the request uses the person's own login. Every
response field is type- and range-checked; any failure hides the Credits entry
instead of showing something wrong. No reset time is shown (the endpoint
carries none).

Only a claude.ai login is sent: `$.session.authorize()` returns `null` on
Bedrock, Vertex and gateways (no first-party credential); an `'api-key'`
credential is skipped because the OAuth endpoint would refuse it on every poll.
In all of these the plugin makes no request. Bedrock was not tested on a real
account; this follows the engine's typed contract.

Polling runs at most once per 5 minutes from the refresh after each response,
on `$.clock.after(0)` so slow endpoints never hold up hooks. The stored reading
itself is the lock: `update()` writes with `ifVersion` (compare-and-set) and
retries, so of racing refreshes only one starts a request. A module-level
in-flight flag (the patch's first version) was rejected: a hung request stopped
polling for good until the module reloaded, and a throw between setting it and
scheduling the timer left it stuck.

A request open 30 minutes is given up: the next refresh asks again, dropping
late answers that no longer match the stored request id (also covering answers
after `/clear`). Cost: at most one abandoned request per 30 minutes against a
hung endpoint.

Hiding stale figures keys on `pendingSince`, the time the current unanswered
streak began, kept across given-up reissues and cleared by a matching answer.
Keying on the time of the last answer was rejected: after any idle gap over 30
minutes, the first request hid the figure until answering, so on Enterprise
(where Credits is the only Limits entry) the whole Limits row flickered out and
back on every return from idle.

### Consequences

- Good: Enterprise seats see their credit spend; Bedrock/Vertex/API-key sessions
  make no extra network call; a hung endpoint recovers without reload.
- Bad: depends on an undocumented endpoint and beta header (`anthropic-beta:
  oauth-2025-04-20`) that may change; figures can be up to 5 minutes old,
  longer while idle.
