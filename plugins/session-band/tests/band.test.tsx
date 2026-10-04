import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage, SessionRateLimit, SessionUsage } from 'claude-code'

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

test('drops the cache row after a model switch', async ($, on) => {
  engine(on, usage([]))
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 })
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
