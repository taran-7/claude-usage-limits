import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionCompactResult } from 'claude-code'

const NOW = Date.parse('2026-10-21T10:00:00Z')
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const BAND = {
  plugin: 'usage-limits',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
type Context = { window: number; tokens?: number; percent?: number }

const measurement = (rateLimits: RateLimit[], context: Context = { window: 200_000 }) => ({
  context,
  rateLimits,
  changed: ['rateLimits' as const, 'context' as const],
})

// What the engine does beneath the plugin: it echoes a measurement and draws
// an empty band of its own when no plugin has anything to show.
const setUp = (on: On, now = NOW) => {
  const clock = mock.clock(on, { now })

  compactions.length = 0
  toasts.length = 0
  compact = DEFAULT_COMPACTION

  on('session.compact', () => {
    compactions.push('called')

    return compact()
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box key="engine" />
  })

  return clock
}

const compactions: string[] = []
const toasts: string[] = []
const SUMMARY = { role: 'assistant' as const, text: 'summary', toolUses: [] }

const DEFAULT_COMPACTION = (): SessionCompactResult => ({
  messages: [SUMMARY],
  tokensBefore: 68_000,
  tokensAfter: 12_000,
})

let compact: () => SessionCompactResult = DEFAULT_COMPACTION

const isoAfter = (ms: number) => new Date(NOW + ms).toISOString()

test('draws context, session and week in one row, on every surface', async ($, on) => {
  setUp(on)

  await $.session.measure(
    measurement(
      [
        { kind: 'five_hour', percentUsed: 23.4, resetsAt: isoAfter(2 * HOUR_MS + 14 * MINUTE_MS) },
        { kind: 'seven_day', percentUsed: 41, resetsAt: isoAfter(3 * DAY_MS + 5 * HOUR_MS) },
      ],
      { window: 200_000, tokens: 68_000, percent: 34 },
    ),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /Контекст/ }))?.text).toBe(
      'Контекст ███░░░░░░░ 34% 68k/200k',
    )
    expect((await ui.find({ type: 'Text', text: /Сесія/ }))?.text).toBe(
      'Сесія ██░░░░░░░░ 23% 2 год 14 хв  ·  Тиждень ████░░░░░░ 41% 3 дн 5 год',
    )
    expect(await ui.findAll({ type: 'Box' })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)

    await ui.unmount()
  }
})

test('the countdown moves with the clock between responses', async ($, on) => {
  const clock = setUp(on)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.session.measure(
    measurement([{ kind: 'five_hour', percentUsed: 10, resetsAt: isoAfter(90 * MINUTE_MS) }]),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Сесія/ }))?.text).toBe('Сесія █░░░░░░░░░ 10% 1 год 30 хв')

  await clock.advance(31 * MINUTE_MS)

  expect((await ui.find({ type: 'Text', text: /Сесія/ }))?.text).toBe('Сесія █░░░░░░░░░ 10% 59 хв')
  await ui.unmount()
})

test('a window that already reset says so instead of a negative time', async ($, on) => {
  setUp(on)

  await $.session.measure(
    measurement([{ kind: 'five_hour', percentUsed: 99, resetsAt: isoAfter(-MINUTE_MS) }]),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Сесія/ }))?.text).toBe('Сесія ██████████ 99% щойно скинуто')
  await ui.unmount()
})

test('the percent is green, yellow or red by how full the window is', async ($, on) => {
  setUp(on)

  await $.session.measure(
    measurement(
      [
        { kind: 'five_hour', percentUsed: 50, resetsAt: isoAfter(HOUR_MS) },
        { kind: 'seven_day', percentUsed: 75, resetsAt: isoAfter(DAY_MS) },
      ],
      { window: 200_000, tokens: 190_000, percent: 95 },
    ),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /^95%$/ }))?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: /^50%$/ }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /^75%$/ }))?.props.color).toBe('warning')
  await ui.unmount()
})

test('draws nothing without a reading, and yields to a survey', async ($, on) => {
  setUp(on)

  const quiet = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await quiet.find({ type: 'Text', text: /Сесія/ })).toBeUndefined()
  await quiet.unmount()

  await $.session.measure(
    measurement([{ kind: 'five_hour', percentUsed: 10, resetsAt: isoAfter(HOUR_MS) }]),
  )

  const surveyed = await $.ui.mount({
    ...BAND,
    surface: 'desktop',
    props: { ...BAND.props, hasSurvey: true },
  })
  expect(await surveyed.find({ type: 'Text', text: /Сесія/ })).toBeUndefined()
  await surveyed.unmount()
})

test('derives the context percent from tokens when the engine reports none', async ($, on) => {
  setUp(on)

  await $.session.measure(measurement([], { window: 1_000_000, tokens: 250_000 }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /Контекст/ }))?.text).toBe('Контекст ███░░░░░░░ 25% 250k/1M')
  await ui.unmount()
})

test('shows the context alone when no subscription limits are reported', async ($, on) => {
  setUp(on)

  await $.session.measure(measurement([], { window: 200_000, tokens: 20_000, percent: 10 }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Контекст/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Сесія/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Тиждень/ })).toBeUndefined()
  await ui.unmount()
})

test('the context follows each measurement', async ($, on) => {
  setUp(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await $.session.measure(measurement([], { window: 200_000, tokens: 40_000, percent: 20 }))
  expect((await ui.find({ type: 'Text', text: /Контекст/ }))?.text).toBe('Контекст ██░░░░░░░░ 20% 40k/200k')

  await $.session.measure(measurement([], { window: 200_000, tokens: 190_000, percent: 95 }))
  expect((await ui.find({ type: 'Text', text: /Контекст/ }))?.text).toBe('Контекст ██████████ 95% 190k/200k')

  await ui.unmount()
})

const measureContext = ($: Engine) =>
  $.session.measure(measurement([], { window: 200_000, tokens: 68_000, percent: 34 }))

test('pressing the context compacts the conversation and shows the size after it', async ($, on) => {
  setUp(on)
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  expect(compactions).toEqual(['called'])
  expect((await ui.find({ type: 'Text', text: /Контекст/ }))?.text).toBe(
    'Контекст █░░░░░░░░░ 6% 12k/200k',
  )
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
  expect(toasts).toEqual(['Стискаю контекст…', 'Контекст стиснуто: 68k → 12k'])
  await ui.unmount()
})

test('a vetoed compaction leaves the context as it was', async ($, on) => {
  setUp(on)
  compact = () => ({ skip: 'off' })
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  expect(compactions).toEqual(['called'])
  expect((await ui.find({ type: 'Text', text: /Контекст/ }))?.text).toBe(
    'Контекст ███░░░░░░░ 34% 68k/200k',
  )
  expect(toasts).toEqual(['Стискаю контекст…', 'Compact скасовано: off'])
  await ui.unmount()
})

test('a compaction that fails leaves the context and the button as they were', async ($, on) => {
  setUp(on)
  compact = () => {
    throw new Error('a turn is running')
  }
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  expect((await ui.find({ type: 'Text', text: /Контекст/ }))?.text).toBe(
    'Контекст ███░░░░░░░ 34% 68k/200k',
  )
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
  expect(toasts).toEqual(['Стискаю контекст…', 'Compact неможливий, поки триває відповідь'])
  await ui.unmount()
})

test('while a turn runs the context is text, not a button', async ($, on) => {
  setUp(on)
  await measureContext($)

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'desktop',
    props: { ...BAND.props, isWorking: true },
  })

  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /Контекст/ }))?.text).toBe(
    'Контекст ███░░░░░░░ 34% 68k/200k',
  )
  await ui.unmount()
})
