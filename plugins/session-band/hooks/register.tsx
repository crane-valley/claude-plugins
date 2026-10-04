import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { RateLimit } from '../types'

const LABEL_WIDTH = 9
const LIMIT_BAR_CELLS = 10
const CONTEXT_BAR_CELLS = 20
const TOP_CATEGORIES = 3
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const TTL_MS: Record<string, number> = { '5m': 5 * MINUTE_MS, '1h': 60 * MINUTE_MS }

const FULL = String.fromCharCode(0x2588)
const EMPTY = String.fromCharCode(0x2591)
const SWATCH = String.fromCharCode(0x25a0)

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'Spend' }

const lastResponseAt = atom({ plugin: 'session-band', key: 'lastResponseAt' } as const, null)
const snapshot = atom({ plugin: 'session-band', key: 'snapshot' } as const, null)

const tokens = (n: number) => {
  if (n >= 1_000_000) {
    return `${Number((n / 1_000_000).toFixed(1))}M`
  }
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

const duration = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / MINUTE_MS))
  if (m < 60) {
    return `${m}m`
  }
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

const clock = (ms: number) => {
  const s = Math.ceil(ms / SECOND_MS)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const bar = (percent: number) => {
  const filled = Math.min(LIMIT_BAR_CELLS, Math.round((percent / 100) * LIMIT_BAR_CELLS))
  return FULL.repeat(filled) + EMPTY.repeat(LIMIT_BAR_CELLS - filled)
}

// Largest-remainder split, so the segments always add up to the filled cells.
const segments = (filled: number, weights: number[]) => {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) {
    return weights.map(() => 0)
  }
  const exact = weights.map(w => (w / total) * filled)
  const cells = exact.map(Math.floor)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest)
  const missing = filled - cells.reduce((a, b) => a + b, 0)
  for (let k = 0; k < missing; k++) {
    cells[order[k]!.i]! += 1
  }
  return cells
}

const severity = (percent: number) => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : undefined)

const refresh = async ($: EngineInterface) => {
  // 'full' sends a token-count request per MCP tool and memory file on every turn; 'summary' is local.
  const usage = await $.session.usage({ breakdown: 'summary' })
  const used = (usage.context.breakdown?.categories ?? [])
    .filter(c => c.kind === 'used')
    .sort((a, b) => b.tokens - a.tokens)
  const limits: RateLimit[] = usage.rateLimits.map(l => {
    const resetsAt = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)
    return { kind: l.kind, percentUsed: l.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
  })
  await update($, snapshot, () => ({
    startedAt: usage.startedAt,
    percent: usage.context.percent ?? null,
    tokens: usage.context.tokens ?? null,
    window: usage.context.window,
    top: used.slice(0, TOP_CATEGORIES).map(({ name, tokens, color }) => ({ name, tokens, color })),
    otherTokens: used.slice(TOP_CATEGORIES).reduce((sum, c) => sum + c.tokens, 0),
    limits,
    costUsd: usage.cost?.usd ?? null,
  }))
}

export const register: Register = (on, options) => {
  // The plugin cannot observe the TTL the engine requested, so the person states it.
  const ttlMs = TTL_MS[String(options.cacheTtl)] ?? TTL_MS['5m']!
  const showCost = options.showCost !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    $.clock.every(SECOND_MS, () => $.ui.invalidate('ui.render'))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.seconds_since_last_response !== undefined) {
      const at = (await $.clock.now()) - e.seconds_since_last_response * SECOND_MS
      await update($, lastResponseAt, () => at)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    // Subagents cache their own prefixes; only the main thread's matters for the next prompt.
    if (e.agentId === undefined && result.usage !== null) {
      const now = await $.clock.now()
      await update($, lastResponseAt, () => now)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, lastResponseAt, () => null)
      await update($, snapshot, () => null)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) {
      return below
    }
    const at = await read($, lastResponseAt)
    const s = await read($, snapshot)
    if (at === null && s === null) {
      return below
    }
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const label = (text: string) => (
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{text}</Text>
      </Box>
    )
    const rows: RenderElement[] = []

    if (at !== null) {
      const left = at + ttlMs - now
      rows.push(
        <Box flexDirection="row" key="cache">
          {label('Cache')}
          <Text color={left > 0 ? undefined : 'warning'}>{left > 0 ? clock(left) : 'expired'}</Text>
        </Box>,
      )
    }

    if (s !== null) {
      rows.push(
        <Box flexDirection="row" key="session">
          {label('Session')}
          <Text>
            {showCost && s.costUsd !== null ? `$${s.costUsd.toFixed(2)}   ` : ''}
            <Text dimColor>{`${duration(now - s.startedAt)} elapsed`}</Text>
          </Text>
        </Box>,
      )

      if (s.limits.length > 0) {
        rows.push(
          <Box flexDirection="row" key="limits">
            {label('Limits')}
            <Box flexDirection="row" flexWrap="wrap" columnGap={4}>
              {s.limits.map(l => (
                <Text>
                  {`${LIMIT_NAMES[l.kind] ?? l.kind} `}
                  <Text color={severity(l.percentUsed)} dimColor={severity(l.percentUsed) === undefined}>{bar(l.percentUsed)}</Text>
                  {` ${l.percentUsed}%`}
                  <Text dimColor>{l.resetsAt === null ? '' : `  resets in ${duration(l.resetsAt - now)}`}</Text>
                </Text>
              ))}
            </Box>
          </Box>,
        )
      }

      const filled = s.percent === null ? 0 : Math.min(CONTEXT_BAR_CELLS, Math.round((s.percent / 100) * CONTEXT_BAR_CELLS))
      const cells = segments(filled, [...s.top.map(c => c.tokens), s.otherTokens])
      rows.push(
        <Box flexDirection="row" key="context">
          {label('Context')}
          <Text wrap="truncate-end">
            {s.top.map((c, i) => <Text color={c.color}>{FULL.repeat(cells[i] ?? 0)}</Text>)}
            <Text dimColor>{FULL.repeat(cells[s.top.length] ?? 0) + EMPTY.repeat(CONTEXT_BAR_CELLS - filled)}</Text>
            {s.percent === null || s.tokens === null ? ' --' : ` ${s.percent}%  ${tokens(s.tokens)} / ${tokens(s.window)}`}
            {s.top.map(c => (
              <Text>
                {'   '}
                <Text color={c.color}>{SWATCH}</Text>
                <Text dimColor>{` ${c.name} ${tokens(c.tokens)}`}</Text>
              </Text>
            ))}
          </Text>
        </Box>,
      )
    }

    // AbovePrompt is one band shared by every plugin; wrapping keeps their rows instead of replacing them.
    return below ? <Box flexDirection="column">{below}{rows}</Box> : <Box flexDirection="column">{rows}</Box>
  })
}
