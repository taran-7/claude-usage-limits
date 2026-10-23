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

const compactions: string[] = []
const commands: string[] = []
const registered: string[] = []
const toasts: string[] = []
const DARK_RED = '#b91c1c'

const LIMITS_COMMAND = {
  command: 'limits',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
}
const SUMMARY = { role: 'assistant' as const, text: 'summary', toolUses: [] }

const DEFAULT_COMPACTION = (): SessionCompactResult => ({
  messages: [SUMMARY],
  tokensBefore: 68_000,
  tokensAfter: 12_000,
})

let compact: () => SessionCompactResult = DEFAULT_COMPACTION
let runCommand: () => { text?: string } = () => ({ text: 'ok' })
let holdCommand = false
let releaseCommand: () => void = () => {}
// What the engine estimates for the live transcript; 0 for no estimate.
let estimatedTokens = 0
// The engine's own figure for the context: absent after a compaction, until the
// next response.
let engineTokens: number | undefined

// What the engine does beneath the plugin: it echoes a measurement, runs a
// command, compacts, estimates the live context and draws an empty band of its
// own when no plugin has anything to show.
const setUp = (on: On, now = NOW) => {
  const clock = mock.clock(on, { now })

  compactions.length = 0
  commands.length = 0
  registered.length = 0
  toasts.length = 0
  compact = DEFAULT_COMPACTION
  runCommand = () => ({ text: 'ok' })
  holdCommand = false
  estimatedTokens = 0
  engineTokens = undefined

  on('command.run', async (_$, e) => {
    commands.push(e.command)

    if (holdCommand) {
      await new Promise<void>(resolve => {
        releaseCommand = resolve
      })
    }

    return runCommand()
  })
  on('session.compact', () => {
    compactions.push('called')

    return compact()
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 200_000,
        ...(engineTokens === undefined ? {} : { tokens: engineTokens, percent: engineTokens / 2_000 }),
        ...(estimatedTokens === 0 ? {} : { breakdown: { totalTokens: estimatedTokens } }),
      },
    },
  }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })
  on('command.register', (_$, e) => {
    registered.push(e.name)

    return { value: { command: e.name } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box key="engine" />
  })

  return clock
}

type Finder = {
  find: (query: { type: string; text: RegExp }) => Promise<{ text: string } | undefined>
}

const contextOf = async (ui: Finder) =>
  (await ui.find({ type: 'Text', text: /Context/ }))?.text

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

    expect(await contextOf(ui)).toBe(
      'Context ███░░░░░ 34% 68k/200k · Session ██░░░░░░ 23% 2h 14m · Week ███░░░░░ 41% 3d 5h',
    )
    // The row that spans the band, the compact button's slot at its left and
    // the readings' own part, which grows and centres them.
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes).toHaveLength(3)
    expect(boxes.filter(box => box.props.justifyContent === 'center')).toHaveLength(1)
    expect(await ui.findAll({ type: 'Button', text: /♻/ })).toHaveLength(1)
    expect((await ui.find({ type: 'Button', text: /♻/ }))?.props.label).toBe('♻️')
    expect((await ui.find({ type: 'Button', text: /×/ }))?.props.role).toBe('dismiss')

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
  expect((await ui.find({ type: 'Text', text: /Session/ }))?.text).toBe('Session █░░░░░░░ 10% 1h 30m')

  await clock.advance(31 * MINUTE_MS)

  expect((await ui.find({ type: 'Text', text: /Session/ }))?.text).toBe('Session █░░░░░░░ 10% 59m')
  await ui.unmount()
})

test('a window that already reset says so and starts again from nothing', async ($, on) => {
  setUp(on)

  await $.session.measure(
    measurement([
      { kind: 'five_hour', percentUsed: 99, resetsAt: isoAfter(-MINUTE_MS) },
      { kind: 'seven_day', percentUsed: 65, resetsAt: isoAfter(-HOUR_MS) },
    ]),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Session/ }))?.text).toBe(
    'Session ░░░░░░░░ 0% just reset · Week ░░░░░░░░ 0% just reset',
  )
  // Nothing to compact without a context reading, so no button either.
  expect(await ui.findAll({ type: 'Button', text: /♻/ })).toHaveLength(0)
  await ui.unmount()
})

test('a window that resets while the row is open drops to nothing at the next tick', async ($, on) => {
  const clock = setUp(on)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.session.measure(
    measurement([{ kind: 'five_hour', percentUsed: 65, resetsAt: isoAfter(10 * MINUTE_MS) }]),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Session/ }))?.text).toBe('Session █████░░░ 65% 10m')

  await clock.advance(11 * MINUTE_MS)

  expect((await ui.find({ type: 'Text', text: /Session/ }))?.text).toBe('Session ░░░░░░░░ 0% just reset')

  // The next response brings the new window's own reading.
  await $.session.measure(
    measurement([{ kind: 'five_hour', percentUsed: 3, resetsAt: isoAfter(5 * HOUR_MS + 11 * MINUTE_MS) }]),
  )

  expect((await ui.find({ type: 'Text', text: /Session/ }))?.text).toBe('Session ░░░░░░░░ 3% 5h 0m')
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

  expect((await ui.find({ type: 'Text', text: /^95%$/ }))?.props.color).toBe(DARK_RED)
  expect((await ui.find({ type: 'Text', text: /^50%$/ }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /^75%$/ }))?.props.color).toBe('warning')
  await ui.unmount()
})

test('draws nothing without a reading, and yields to a survey', async ($, on) => {
  setUp(on)

  const quiet = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await quiet.find({ type: 'Text', text: /Session/ })).toBeUndefined()
  await quiet.unmount()

  await $.session.measure(
    measurement([{ kind: 'five_hour', percentUsed: 10, resetsAt: isoAfter(HOUR_MS) }]),
  )

  const surveyed = await $.ui.mount({
    ...BAND,
    surface: 'desktop',
    props: { ...BAND.props, hasSurvey: true },
  })
  expect(await surveyed.find({ type: 'Text', text: /Session/ })).toBeUndefined()
  await surveyed.unmount()
})

test('derives the context percent from tokens when the engine reports none', async ($, on) => {
  setUp(on)

  await $.session.measure(measurement([], { window: 1_000_000, tokens: 250_000 }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await contextOf(ui)).toBe('Context ██░░░░░░ 25% 250k/1M')
  await ui.unmount()
})

test('shows the context alone when no subscription limits are reported', async ($, on) => {
  setUp(on)

  await $.session.measure(measurement([], { window: 200_000, tokens: 20_000, percent: 10 }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await contextOf(ui)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Session/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Week/ })).toBeUndefined()
  await ui.unmount()
})

test('the context follows each measurement', async ($, on) => {
  setUp(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await $.session.measure(measurement([], { window: 200_000, tokens: 40_000, percent: 20 }))
  expect(await contextOf(ui)).toBe('Context ██░░░░░░ 20% 40k/200k')

  await $.session.measure(measurement([], { window: 200_000, tokens: 190_000, percent: 95 }))
  expect(await contextOf(ui)).toBe('Context ████████ 95% 190k/200k')

  await ui.unmount()
})

const measureContext = ($: Engine) =>
  $.session.measure(measurement([], { window: 200_000, tokens: 68_000, percent: 34 }))

test('pressing the button runs /compact as a command', async ($, on) => {
  setUp(on)
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  expect(commands).toEqual(['compact'])
  expect(toasts).toEqual([])
  expect(await ui.findAll({ type: 'Button', text: /♻/ })).toHaveLength(1)
  await ui.unmount()
})

test('a compaction refreshes the context from the live transcript', async ($, on) => {
  const clock = setUp(on)
  estimatedTokens = 24_000
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })

  expect(compactions).toEqual(['called'])
  expect(await contextOf(ui)).toBe('Context ███░░░░░ 34% 68k/200k')

  await clock.advance(1_500)

  expect(await contextOf(ui)).toBe('Context █░░░░░░░ 12% 24k/200k')
  await ui.unmount()
})

test('without an estimate a compaction leaves the context as it was', async ($, on) => {
  const clock = setUp(on)
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  await clock.advance(1_500)

  expect(await contextOf(ui)).toBe('Context ███░░░░░ 34% 68k/200k')
  await ui.unmount()
})

test("after the button's /compact the context follows the new conversation", async ($, on) => {
  const clock = setUp(on)
  estimatedTokens = 24_000
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })
  await clock.advance(1_500)

  expect(await contextOf(ui)).toBe('Context █░░░░░░░ 12% 24k/200k')
  await ui.unmount()
})

const commandRow = (text: string, over: { door?: 'command' | 'note'; agentId?: string } = {}) => ({
  door: over.door ?? ('command' as const),
  origin: { kind: 'engine' as const },
  uuid: 'row',
  agentId: over.agentId,
  message: { type: 'user' as const, content: [{ type: 'text', text }] },
})

const COMPACT_COMMAND = '<command-name>/compact</command-name>'
const COMPACT_OUTPUT = '<local-command-stdout>Compacted </local-command-stdout>'

test('the rows a typed /compact leaves refresh the context', async ($, on) => {
  const clock = setUp(on)
  estimatedTokens = 24_000
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  for (const text of [COMPACT_COMMAND, COMPACT_OUTPUT]) {
    await $.session.measure(measurement([], { window: 200_000, tokens: 68_000, percent: 34 }))
    await $.session.append(commandRow(text))
    expect(await contextOf(ui)).toBe('Context ███░░░░░ 34% 68k/200k')

    await clock.advance(1_500)
    expect(await contextOf(ui)).toBe('Context █░░░░░░░ 12% 24k/200k')
  }

  await ui.unmount()
})

test("another command's rows, a subagent's and a note leave the context as it was", async ($, on) => {
  const clock = setUp(on)
  estimatedTokens = 24_000
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await $.session.append(commandRow('<command-name>/limits</command-name>'))
  await $.session.append(commandRow(COMPACT_COMMAND, { agentId: 'sub' }))
  await $.session.append(commandRow(COMPACT_COMMAND, { door: 'note' }))
  await clock.advance(1_500)

  expect(await contextOf(ui)).toBe('Context ███░░░░░ 34% 68k/200k')
  await ui.unmount()
})

test('a compaction nothing announced is caught on the next tick', async ($, on) => {
  const clock = setUp(on)
  estimatedTokens = 24_000

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await contextOf(ui)).toBe('Context ███░░░░░ 34% 68k/200k')

  await clock.advance(30_000)

  expect(await contextOf(ui)).toBe('Context █░░░░░░░ 12% 24k/200k')
  await ui.unmount()
})

test('the tick leaves a context the engine still reports', async ($, on) => {
  const clock = setUp(on)
  estimatedTokens = 24_000
  engineTokens = 68_000

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await clock.advance(30_000)

  expect(await contextOf(ui)).toBe('Context ███░░░░░ 34% 68k/200k')
  await ui.unmount()
})

test('the tick does not invent a context before the engine has reported one', async ($, on) => {
  const clock = setUp(on)
  estimatedTokens = 24_000

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await clock.advance(30_000)

  expect(await contextOf(ui)).toBeUndefined()
  await ui.unmount()
})

test('a vetoed, a precomputed and a subagent compaction leave the context as it was', async ($, on) => {
  const clock = setUp(on)
  estimatedTokens = 24_000
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const before = 'Context ███░░░░░ 34% 68k/200k'

  compact = () => ({ skip: 'off' })
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await clock.advance(1_500)
  expect(await contextOf(ui)).toBe(before)

  compact = DEFAULT_COMPACTION
  await $.session.compact({ trigger: 'precompute', messages: [SUMMARY] })
  await clock.advance(1_500)
  expect(await contextOf(ui)).toBe(before)

  await $.session.compact({ trigger: 'auto', messages: [SUMMARY], agentId: 'sub' })
  await clock.advance(1_500)
  expect(await contextOf(ui)).toBe(before)
  await ui.unmount()
})

test('a /compact that cannot run leaves the context and the button as they were', async ($, on) => {
  setUp(on)
  runCommand = () => {
    throw new Error('refused')
  }
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  expect(toasts).toEqual(['Compact could not be started'])
  expect(await contextOf(ui)).toBe('Context ███░░░░░ 34% 68k/200k')
  expect(await ui.findAll({ type: 'Button', text: /♻/ })).toHaveLength(1)
  await ui.unmount()
})

test('while /compact runs the button gives way to an hourglass', async ($, on) => {
  const clock = setUp(on)
  holdCommand = true
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const pressed = ui.press({ key: 'compact' })

  await clock.advance(0)

  expect(await ui.findAll({ type: 'Button', text: /♻/ })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /⏳/ })).toBeDefined()

  releaseCommand()
  await pressed

  expect(await ui.findAll({ type: 'Button', text: /♻/ })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /⏳/ })).toBeUndefined()
  await ui.unmount()
})

test('a reading without a context figure keeps the last one', async ($, on) => {
  setUp(on)
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.session.measure(measurement([], { window: 200_000 }))

  expect(await contextOf(ui)).toBe('Context ███░░░░░ 34% 68k/200k')
  await ui.unmount()
})

test('the context is green to 40%, yellow from 41% to 60% and dark red from 61%', async ($, on) => {
  setUp(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const colorAt = async (percent: number) => {
    await $.session.measure(
      measurement([], { window: 1_000_000, tokens: Math.round(percent * 10_000), percent }),
    )

    const shown = new RegExp(`^${Math.round(percent)}%$`)

    return (await ui.find({ type: 'Text', text: shown }))?.props.color
  }

  expect(await colorAt(5)).toBe('success')
  expect(await colorAt(40)).toBe('success')
  expect(await colorAt(40.4)).toBe('success')
  expect(await colorAt(40.6)).toBe('warning')
  expect(await colorAt(41)).toBe('warning')
  expect(await colorAt(60)).toBe('warning')
  expect(await colorAt(60.4)).toBe('warning')
  expect(await colorAt(60.6)).toBe(DARK_RED)
  expect(await colorAt(61)).toBe(DARK_RED)
  expect(await colorAt(99)).toBe(DARK_RED)
  expect(await colorAt(100)).toBe(DARK_RED)

  await ui.unmount()
})

test('the close button hides the band in this chat, and new readings do not bring it back', async ($, on) => {
  setUp(on)
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await contextOf(ui)).toBeDefined()

  await ui.press({ key: 'close' })
  expect(await contextOf(ui)).toBeUndefined()

  await measureContext($)
  expect(await contextOf(ui)).toBeUndefined()
  await ui.unmount()
})

test('the close button is there with the limits alone, and the compact button is not', async ($, on) => {
  setUp(on)

  await $.session.measure(
    measurement([{ kind: 'five_hour', percentUsed: 10, resetsAt: isoAfter(HOUR_MS) }]),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.findAll({ type: 'Button', text: /×/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Button', text: /↻/ })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Button', text: /♻/ })).toHaveLength(0)
  await ui.unmount()
})

const EDITOR_GREEN = '#25E712'
const EDITOR_YELLOW = '#ca8a04'
const EDITOR_RED = '#C1121C'

const editorBand = (columns: number) =>
  ({ ...BAND, surface: 'vscode', props: { ...BAND.props, bodyColumns: columns } }) as const

test('in the editor the band is one small line of rings and text without the labels', async ($, on) => {
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

  const ui = await $.ui.mount(editorBand(100))

  const rings = await ui.findAll({ type: 'Svg' })
  expect(rings.map(ring => ring.props.alt)).toEqual(['Context 34%', 'Session 23%', 'Week 41%'])
  // The first ring: a track and an arc of 34% of the circumference (37.70).
  expect(rings[0]?.props.source).toContain('stroke-dasharray="12.82 37.70"')
  expect(rings[0]?.props.source).toContain(`stroke="${EDITOR_GREEN}"`)
  expect((await ui.find({ type: 'Text', text: /^34%/ }))?.text).toBe('34% 68k/200k')
  expect((await ui.find({ type: 'Text', text: /^23%/ }))?.text).toBe('23% 2h 14m')
  expect((await ui.find({ type: 'Text', text: /^41%/ }))?.text).toBe('41% 3d 5h')
  expect(await ui.find({ type: 'Text', text: /Context|Session|Week/ })).toBeUndefined()

  // One row that does not wrap, its readings free to shrink, in the caption size.
  const [row, , readings] = await ui.findAll({ type: 'Box' })
  expect(row?.props.flexWrap).toBe('nowrap')
  expect(readings?.props.minWidth).toBe(0)
  expect((await ui.find({ type: 'Text', text: /^34%/ }))?.props.size).toBe('caption')
  // Every part says it truncates, as the editor wraps the ones that do not.
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.length).toBeGreaterThan(1)
  expect(texts.filter(text => text.props.wrap !== 'truncate-end')).toHaveLength(0)
  expect(await ui.findAll({ type: 'Button', text: /♻/ })).toHaveLength(1)
  expect((await ui.find({ type: 'Button', text: /×/ }))?.props.role).toBe('dismiss')
  await ui.unmount()
})

test('a band too narrow for the rings is drawn as text alone, and one of unknown width as rings', async ($, on) => {
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

  const narrow = await $.ui.mount(editorBand(31))

  expect(await narrow.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await narrow.find({ type: 'Text', text: /34%/ }))?.text).toBe(
    '34% 68k/200k · 23% 2h 14m · 41% 3d 5h',
  )
  await narrow.unmount()

  for (const columns of [32, 0]) {
    const wide = await $.ui.mount(editorBand(columns))

    expect(await wide.findAll({ type: 'Svg' })).toHaveLength(3)
    await wide.unmount()
  }
})

test('in the editor the colours are given outright, as its theme leaves some unset', async ($, on) => {
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

  for (const columns of [100, 40]) {
    const editor = await $.ui.mount(editorBand(columns))

    expect((await editor.find({ type: 'Text', text: /^95%$/ }))?.props.color).toBe(EDITOR_RED)
    expect((await editor.find({ type: 'Text', text: /^50%$/ }))?.props.color).toBe(EDITOR_GREEN)
    expect((await editor.find({ type: 'Text', text: /^75%$/ }))?.props.color).toBe(EDITOR_YELLOW)
    await editor.unmount()
  }

  // The rings take the same colours.
  const ringed = await $.ui.mount(editorBand(100))
  const rings = await ringed.findAll({ type: 'Svg' })
  const arcColours = rings.map(
    ring => /stroke="(#[0-9A-Fa-f]{6})" stroke-width="2.5" stroke-dasharray/.exec(String(ring.props.source))?.[1],
  )

  expect(arcColours).toEqual([EDITOR_RED, EDITOR_GREEN, EDITOR_YELLOW])
  await ringed.unmount()

  // The desktop keeps the theme's own colours.
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await desktop.find({ type: 'Text', text: /^75%$/ }))?.props.color).toBe('warning')
  expect((await desktop.find({ type: 'Text', text: /^95%$/ }))?.props.color).toBe(DARK_RED)
  expect((await desktop.find({ type: 'Text', text: /Session/ }))?.props.size).toBeUndefined()
  await desktop.unmount()
})

test('an empty ring has no arc and a full one is closed', async ($, on) => {
  setUp(on)
  await $.session.measure(
    measurement(
      [
        { kind: 'five_hour', percentUsed: 0, resetsAt: isoAfter(HOUR_MS) },
        { kind: 'seven_day', percentUsed: 100, resetsAt: isoAfter(DAY_MS) },
      ],
      { window: 200_000, tokens: 0, percent: 0 },
    ),
  )

  const ui = await $.ui.mount(editorBand(100))
  const [empty, , full] = await ui.findAll({ type: 'Svg' })

  expect(String(empty?.props.source).match(/<circle/g)).toHaveLength(1)
  expect(String(full?.props.source)).toContain('stroke-dasharray="37.70 37.70"')
  await ui.unmount()
})

test('registers /limits when the session starts', async ($, on) => {
  setUp(on)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  expect(registered).toEqual(['limits'])
})

test('/limits hides an open band and brings a closed one back', async ($, on) => {
  setUp(on)
  await measureContext($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await contextOf(ui)).toBeDefined()

  const hidden = await $.command.run(LIMITS_COMMAND)
  expect(hidden.text).toContain('hidden')
  expect(await contextOf(ui)).toBeUndefined()

  const shown = await $.command.run(LIMITS_COMMAND)
  expect(shown.text).toContain('shown')
  expect(await contextOf(ui)).toBeDefined()

  await ui.press({ key: 'close' })
  expect(await contextOf(ui)).toBeUndefined()

  await $.command.run(LIMITS_COMMAND)
  expect(await contextOf(ui)).toBeDefined()
  await ui.unmount()
})
