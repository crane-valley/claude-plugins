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
- A fixed 30-second retry after a failed request.

## Decision Outcome

Chosen: an opt-in `showCredits` option that polls the usage endpoint with the
claude.ai login, with the stored reading as the lock and staleness keyed on
`pendingSince`.

The `userConfig` option `showCredits` (default `false`) is opt-in because the
endpoint is undocumented and the request uses the person's own login. Every
response field is type- and range-checked; an answer that cannot be used hides
the Credits entry instead of showing something wrong, while a failed request
keeps the last figure (see below). No reset time is shown (the endpoint carries
none).

Only a claude.ai login is sent: `$.session.authorize()` returns `null` on
Bedrock, Vertex and gateways (no first-party credential); an `'api-key'`
credential is skipped because the OAuth endpoint would refuse it on every poll.
In all of these the plugin makes no request. Bedrock was not tested on a real
account; this follows the engine's typed contract.

Polling runs at most once per 5 minutes, sooner after a failed request (30
seconds, doubling with each failure in a row back up to 5 minutes), from the
refresh after each response, on `$.clock.after(0)` so slow endpoints never hold
up hooks. The stored reading itself is the lock: `update()` writes with
`ifVersion` (compare-and-set) and retries, so of racing refreshes only one
starts a request. A module-level in-flight flag (the patch's first version) was
rejected: a hung request stopped polling for good until the module reloaded, and
a throw between setting it and scheduling the timer left it stuck.

A request open 30 minutes is given up: the next refresh asks again, dropping
late answers that no longer match the stored request id (also covering answers
after `/clear`). Cost: at most one abandoned request per 30 minutes against a
hung endpoint.

Hiding stale figures keys on `pendingSince`, the time of the first ask since the
last answer, kept across both given-up and failed re-asks and cleared by a
matching answer. Keying on the time of the last answer was rejected: after any
idle gap over 30 minutes, the first request hid the figure until answering, so
on Enterprise (where Credits is the only Limits entry) the whole Limits row
flickered out and back on every return from idle.

Failed requests (no claude.ai login yet, an HTTP error, or a network error)
retry sooner, keeping the last figure shown so a passing error does not make the
row blink. The wait is 30 seconds after the first failure and doubles with each
failure in a row (30 s, 60 s, 120 s, 240 s) up to the normal 5-minute interval;
any answer resets it. The case is a session started with an expired login, whose
first request fails before `/login`; no engine event signals the login change,
so the retry is timed. Re-asks run only from the refresh after a response, not
on their own timer, so after `/login` nothing happens until the next response at
least that long after the failure. A fixed 30-second retry, as first written, was
rejected: a lasting 429 or outage would be asked every 30 seconds during active
use. Hiding the figure on any failed request was rejected: a single transient
error would blink the Limits row (on Enterprise, Credits is the only Limits
entry), the same flicker the `pendingSince` rule was chosen to avoid.

### Consequences

- Good: Enterprise seats see their credit spend; Bedrock/Vertex/API-key sessions
  make no extra network call; a hung endpoint recovers without reload.
- Bad: depends on an undocumented endpoint and beta header (`anthropic-beta:
  oauth-2025-04-20`) that may change; figures can be up to 5 minutes old (up to
  30 minutes on failure), longer while idle.

Amended 2026-10-07: failed requests back off from 30 seconds and keep the last figure.
