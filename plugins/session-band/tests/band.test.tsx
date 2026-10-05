import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionAuthorization, SessionMessage, SessionRateLimit, SessionUsage } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'session-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

// The test's hooks stand for the engine, which draws nothing of its own in the band.
const engine = (on: On, measured: SessionUsage) => {
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: measured }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('session.compact', () => ({ messages: SUMMARY }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return clock
}

const SUMMARY: SessionMessage[] = [{ role: 'user', text: 'summary', toolUses: [] }]

const usage = (rateLimits: SessionRateLimit[]): SessionUsage => ({
  startedAt: 0,
  rateLimits,
  cost: { usd: 1.5 },
  context: {
    tokens: 250_000,
    window: 1_000_000,
    percent: 25,
    breakdown: {
      categories: [
        { name: 'Messages', tokens: 180_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'System tools', tokens: 40_000, color: 'inactive', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 780_000, color: 'inactive', isDeferred: false, kind: 'free' },
      ],
      totalTokens: 220_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      autocompactSource: 'model-default',
      percentage: 22,
      gridRows: [],
      model: 'test-model',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
})

test('draws the cache, session, limits and context rows on terminal and desktop', async ($, on) => {
  const measured = usage([{ kind: 'five_hour', percentUsed: 80, resetsAt: '2100-01-01T00:00:00Z' }])
  engine(on, measured)
  await $.session.measure({ context: measured.context, rateLimits: measured.rateLimits, changed: ['context'] })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: '4:00' })).toBeDefined()
    expect(await ui.find({ text: /\$1\.50/ })).toBeDefined()
    expect(await ui.find({ text: /^5h / })).toBeDefined()
    expect(await ui.find({ text: /25%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('omits the limits row while no window has a reading', async ($, on) => {
  const measured = usage([])
  engine(on, measured)
  await $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /25%/ })).toBeDefined()
  expect(await ui.find({ text: 'Limits' })).toBeUndefined()
})

test('labels a limit window it does not know by its raw kind', async ($, on) => {
  const measured = usage([{ kind: 'monthly_spend', percentUsed: 104 }])
  engine(on, measured)
  await $.session.measure({ context: measured.context, rateLimits: measured.rateLimits, changed: ['rateLimits'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /^monthly_spend / })).toBeDefined()
})

test('counts the cache down from the configured TTL', { options: { cacheTtl: '1h' } }, async ($, on) => {
  engine(on, usage([]))
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: '59:00' })).toBeDefined()
})

test('keeps the filled share of the context bar when the breakdown is missing', async ($, on) => {
  const measured: SessionUsage = { ...usage([]), context: { tokens: 250_000, window: 1_000_000, percent: 25 } }
  engine(on, measured)
  await $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const filled = String.fromCharCode(0x2588).repeat(5) + String.fromCharCode(0x2591).repeat(15)
  expect(await ui.find({ text: filled })).toBeDefined()
})

test('fills the session rows on resume before any new response', async ($, on) => {
  engine(on, usage([]))
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /25%/ })).toBeDefined()
})

test('drops the cache row after compaction', async ($, on) => {
  engine(on, usage([]))
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 })
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: 'Cache' })).toBeUndefined()
})

test('drops the cache row and re-reads the context window after a model switch', async ($, on) => {
  const measured = usage([])
  engine(on, measured)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 })
  measured.context = { tokens: 100_000, window: 200_000, percent: 50 }
  await $.classic.PostModelSwitch({
    from_model: 'model-a',
    to_model: 'model-b',
    requested_model: 'model-b',
    source: 'command',
    context_tokens: 1000,
    prompt_cache_warm: true,
    cache_ttl: '5m',
    estimated_cache_write_usd: 0.01,
    pricing: 'catalog',
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: 'Cache' })).toBeUndefined()
  expect(await ui.find({ text: /50%  100k \/ 200k/ })).toBeDefined()
})

test('counts the cache from the start of a request that touched the cache', async ($, on) => {
  const clock = engine(on, usage([]))
  let cacheTokens = 0
  on('turn.step', async function* () {
    await clock.advance(60_000)
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: 'm', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: cacheTokens, cache_creation_input_tokens: 0 },
    }
  })
  const respond = async (tokens: number) => {
    cacheTokens = tokens
    const step = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of step) {
    }
    await step.result
  }

  await respond(0)
  const cold = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await cold.find({ text: 'Cache' })).toBeUndefined()
  await cold.unmount()

  await respond(5000)
  const warm = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await warm.find({ text: '4:00' })).toBeDefined()
})

test('hides a rate-limit window once it has reset', async ($, on) => {
  const measured = usage([{ kind: 'five_hour', percentUsed: 80, resetsAt: '1970-01-01T00:01:00Z' }])
  const clock = engine(on, measured)
  await $.session.measure({ context: measured.context, rateLimits: measured.rateLimits, changed: ['rateLimits'] })

  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await before.find({ text: /^5h / })).toBeDefined()
  await before.unmount()

  await clock.advance(120_000)
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await after.find({ text: 'Limits' })).toBeUndefined()
})

test('keeps the cache row through a subagent compaction or model switch', async ($, on) => {
  engine(on, usage([]))
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 })
  await $.session.compact({ trigger: 'auto', messages: SUMMARY, agentId: 'sub' })
  await $.classic.PostModelSwitch({
    agent_id: 'sub',
    from_model: 'model-a',
    to_model: 'model-b',
    requested_model: null,
    source: 'auto',
    context_tokens: 1000,
    prompt_cache_warm: true,
    cache_ttl: '5m',
    estimated_cache_write_usd: 0.01,
    pricing: 'catalog',
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: '4:00' })).toBeDefined()
})

test('marks a countdown restored on resume as an estimate until a cached response', async ($, on) => {
  const clock = engine(on, usage([]))
  on('turn.step', async function* () {
    await clock.advance(60_000)
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: 'm', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    }
  })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 })

  const resumed = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await resumed.find({ text: '4:00' })).toBeDefined()
  expect(await resumed.find({ text: /estimated/ })).toBeDefined()
  await resumed.unmount()

  const step = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of step) {
  }
  await step.result
  const live = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await live.find({ text: '4:00' })).toBeDefined()
  expect(await live.find({ text: /estimated/ })).toBeUndefined()
})

test('shows the cache as expired on resume when the engine says it likely expired', { options: { cacheTtl: '1h' } }, async ($, on) => {
  engine(on, usage([]))
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, prompt_cache_likely_expired: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: 'expired' })).toBeDefined()
})

const creditsEndpoint = (
  on: On,
  reply: { status: number; text: string },
  authorization: SessionAuthorization = { handle: 'test-handle', kind: 'bearer' },
) => {
  const calls = { count: 0 }
  on('session.authorize', () => ({ value: authorization }))
  on('http.fetch', () => {
    calls.count += 1
    return { value: { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text: reply.text } }
  })
  return calls
}

const CREDITS_BODY = JSON.stringify({ five_hour: null, seven_day: null, extra_usage: { is_enabled: true, utilization: 42.25 } })

test('leaves the usage endpoint alone unless showCredits is on', async ($, on) => {
  const measured = usage([])
  const clock = engine(on, measured)
  const calls = creditsEndpoint(on, { status: 200, text: CREDITS_BODY })
  await $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: 'Limits' })).toBeUndefined()
  expect(calls.count).toBe(0)
})

test('shows usage credits under Limits when showCredits is on', { options: { showCredits: true } }, async ($, on) => {
  const measured = usage([])
  const clock = engine(on, measured)
  creditsEndpoint(on, { status: 200, text: CREDITS_BODY })
  await $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })
  await clock.advance(0)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /^Credits / })).toBeDefined()
    expect(await ui.find({ text: /42\.3%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('asks the usage endpoint at most once per five minutes', { options: { showCredits: true } }, async ($, on) => {
  const measured = usage([])
  const clock = engine(on, measured)
  const calls = creditsEndpoint(on, { status: 200, text: CREDITS_BODY })
  const measure = () => $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })

  await measure()
  await clock.advance(60_000)
  await measure()
  expect(calls.count).toBe(1)

  await clock.advance(5 * 60_000)
  await measure()
  await clock.advance(0)
  expect(calls.count).toBe(2)
})

for (const [name, reply] of [
  ['an error status', { status: 500, text: CREDITS_BODY }],
  ['a body that is not JSON', { status: 200, text: '<html>' }],
  ['credits turned off', { status: 200, text: JSON.stringify({ extra_usage: { is_enabled: false, utilization: 10 } }) }],
  ['no extra_usage field', { status: 200, text: JSON.stringify({ five_hour: null }) }],
  ['a negative utilization', { status: 200, text: JSON.stringify({ extra_usage: { is_enabled: true, utilization: -10 } }) }],
  ['an unbounded utilization', { status: 200, text: JSON.stringify({ extra_usage: { is_enabled: true, utilization: 1e308 } }) }],
] as const) {
  test(`hides usage credits on ${name}`, { options: { showCredits: true } }, async ($, on) => {
    const measured = usage([])
    const clock = engine(on, measured)
    const calls = creditsEndpoint(on, reply)
    await $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })
    await clock.advance(0)
    expect(calls.count).toBe(1)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ text: 'Limits' })).toBeUndefined()
    expect(await ui.find({ text: /25%/ })).toBeDefined()
  })
}

for (const [name, authorization] of [
  ['without a first-party credential, as on Bedrock or Vertex', null],
  ['with an API key, which the endpoint does not take', { handle: 'test-handle', kind: 'api-key' }],
] as const) {
  test(`skips the usage endpoint ${name}`, { options: { showCredits: true } }, async ($, on) => {
    const measured = usage([])
    const clock = engine(on, measured)
    const calls = creditsEndpoint(on, { status: 200, text: CREDITS_BODY }, authorization)
    await $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })
    await clock.advance(0)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ text: 'Limits' })).toBeUndefined()
    expect(await ui.find({ text: /25%/ })).toBeDefined()
    expect(calls.count).toBe(0)
  })
}

const withUtilization = (utilization: number) => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({ extra_usage: { is_enabled: true, utilization } }),
})

test('asks again once a request has hung for 30 minutes and drops its late answer', { options: { showCredits: true } }, async ($, on) => {
  const measured = usage([])
  const clock = engine(on, measured)
  let answerHung = (_: number) => {}
  const calls = { count: 0 }
  on('session.authorize', () => ({ value: { handle: 'test-handle', kind: 'bearer' } }))
  on('http.fetch', () => {
    calls.count += 1
    if (calls.count === 1) {
      return new Promise(resolve => {
        answerHung = utilization => resolve({ value: withUtilization(utilization) })
      })
    }
    return { value: withUtilization(42.25) }
  })
  const measure = () => $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })

  await measure()
  await clock.advance(10 * 60_000)
  await measure()
  expect(calls.count).toBe(1)

  await clock.advance(25 * 60_000)
  await measure()
  await clock.advance(0)
  expect(calls.count).toBe(2)

  answerHung(10)
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /42\.3%/ })).toBeDefined()
  expect(await ui.find({ text: /10%/ })).toBeUndefined()
})

test('hides the credits figure while a request hangs past 30 minutes', { options: { showCredits: true } }, async ($, on) => {
  const measured = usage([])
  const clock = engine(on, measured)
  const calls = { count: 0 }
  on('session.authorize', () => ({ value: { handle: 'test-handle', kind: 'bearer' } }))
  on('http.fetch', () => {
    calls.count += 1
    return calls.count === 1 ? { value: withUtilization(42.25) } : new Promise(() => {})
  })
  const measure = () => $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })

  await measure()
  await clock.advance(0)
  await clock.advance(5 * 60_000)
  await measure()
  await clock.advance(0)
  expect(calls.count).toBe(2)

  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await before.find({ text: /42\.3%/ })).toBeDefined()
  await before.unmount()
  await clock.advance(30 * 60_000)
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await after.find({ text: /42\.3%/ })).toBeUndefined()
})

test('keeps the credits figure while the first request after an idle hour is out', { options: { showCredits: true } }, async ($, on) => {
  const measured = usage([])
  const clock = engine(on, measured)
  creditsEndpoint(on, { status: 200, text: CREDITS_BODY })
  const measure = () => $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })

  await measure()
  await clock.advance(0)
  await clock.advance(60 * 60_000)
  await measure()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /42\.3%/ })).toBeDefined()
})

test('shows 0% for an allowance with nothing spent, which reports no utilization', { options: { showCredits: true } }, async ($, on) => {
  const measured = usage([])
  const clock = engine(on, measured)
  const body = { extra_usage: { is_enabled: true, monthly_limit: 50000, used_credits: 0, utilization: null, currency: 'USD' } }
  creditsEndpoint(on, { status: 200, text: JSON.stringify(body) })
  await $.session.measure({ context: measured.context, rateLimits: [], changed: ['context'] })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /^Credits .* 0%$/ })).toBeDefined()
})
