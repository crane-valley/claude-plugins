import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit, SessionUsage } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'session-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

// The test's hooks stand for the engine, which draws nothing of its own in the band.
const engine = (on: On, measured: SessionUsage) => {
  mock.clock(on)
  on('session.usage', () => ({ value: measured }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

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
