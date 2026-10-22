import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { ContextFill, LimitWindow, Limits } from '../types'

const TICK_MS = 30_000
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WARNING_AT = 70
const ERROR_AT = 90
const BAR_WIDTH = 8
// The context is judged on the percent as it is shown: green up to 40, yellow
// 41 to 60, dark red from 61. The limits keep WARNING_AT and ERROR_AT.
const CONTEXT_GREEN_UNTIL = 40
const CONTEXT_YELLOW_UNTIL = 60
const DARK_RED = '#b91c1c'
const SEPARATOR = ' · '
const COMPACT_ICON = '🗜️'
const CLOSE_ICON = '×'
const COMMAND = 'limits'
const COMPACTION_SETTLE_MS = 1_500

type Segment = {
  key: string
  label: string
  percent: number
  color: string
  detail: string
}

const limits = atom(
  { plugin: 'usage-limits', key: 'limits' } as const,
  { session: null, week: null },
)
const context = atom({ plugin: 'usage-limits', key: 'context' } as const, null)
const compacting = atom({ plugin: 'usage-limits', key: 'isCompacting' } as const, false)
const hidden = atom({ plugin: 'usage-limits', key: 'isHidden' } as const, false)
const tick = atom({ plugin: 'usage-limits', key: 'tick' } as const, 0)

const toContextFill = (usage: SessionContextUsage): ContextFill | null => {
  const { percent, tokens, window } = usage

  if (percent !== undefined) {
    return { percent, tokens: tokens ?? null, window }
  }
  if (tokens === undefined || window <= 0) {
    return null
  }

  return { percent: (tokens / window) * 100, tokens, window }
}

const toWindow = (rate: SessionRateLimit | undefined): LimitWindow | null =>
  rate === undefined
    ? null
    : { percentUsed: rate.percentUsed, resetsAt: rate.resetsAt ?? null }

const toLimits = (rates: readonly SessionRateLimit[]): Limits => ({
  session: toWindow(rates.find(rate => rate.kind === 'five_hour')),
  week: toWindow(rates.find(rate => rate.kind === 'seven_day')),
})

const formatTokens = (count: number): string => {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

const formatRemaining = (ms: number): string => {
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)

  if (days > 0) return `${days} дн ${hours} год`
  if (hours > 0) return `${hours} год ${minutes} хв`
  return `${Math.max(minutes, 1)} хв`
}

const describeContext = (fill: ContextFill): string =>
  fill.tokens === null
    ? `вікно ${formatTokens(fill.window)}`
    : `${formatTokens(fill.tokens)}/${formatTokens(fill.window)}`

const describeReset = (window: LimitWindow, now: number): string => {
  if (window.resetsAt === null) return ''

  const remaining = Date.parse(window.resetsAt) - now

  return remaining > 0 ? formatRemaining(remaining) : 'щойно скинуто'
}

const drawBar = (percent: number): string => {
  const filled = Math.round((Math.min(percent, 100) * BAR_WIDTH) / 100)

  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

const pickColor = (percent: number): 'success' | 'warning' | 'error' => {
  if (percent >= ERROR_AT) return 'error'
  if (percent >= WARNING_AT) return 'warning'
  return 'success'
}

const pickContextColor = (percent: number): string => {
  const shown = Math.round(percent)

  if (shown <= CONTEXT_GREEN_UNTIL) return 'success'
  if (shown <= CONTEXT_YELLOW_UNTIL) return 'warning'
  return DARK_RED
}

const toSegments = (
  fill: ContextFill | null,
  { session, week }: Limits,
  now: number,
): Segment[] => {
  const segments: Segment[] = []

  if (fill !== null) {
    segments.push({
      key: 'context',
      label: 'Контекст',
      percent: fill.percent,
      color: pickContextColor(fill.percent),
      detail: describeContext(fill),
    })
  }
  if (session !== null) {
    segments.push({
      key: 'session',
      label: 'Сесія',
      percent: session.percentUsed,
      color: pickColor(session.percentUsed),
      detail: describeReset(session, now),
    })
  }
  if (week !== null) {
    segments.push({
      key: 'week',
      label: 'Тиждень',
      percent: week.percentUsed,
      color: pickColor(week.percentUsed),
      detail: describeReset(week, now),
    })
  }

  return segments
}

// What the context is worth once a compaction is done. The engine reports a
// new figure only with the next response, so until then the local estimate of
// the live transcript is the best reading there is. The compaction's own count
// stands in where that estimate is not to be had.
const refreshAfterCompaction = async (
  $: EngineInterface,
  tokensAfter: number | undefined,
) => {
  try {
    const { context: usage } = await $.session.usage({ breakdown: 'summary' })
    const tokens = usage.breakdown?.totalTokens ?? tokensAfter

    if (tokens === undefined) return

    await update($, context, fill =>
      toContextFill({ window: fill?.window ?? usage.window, tokens }),
    )
  } catch {
    // The bar is a convenience: the next response reports the real figure.
  }
}

// Runs the real `/compact`, so it shows in the chat as if it were typed. It is
// queued until the session is idle, so a press during a turn is not lost.
const compactNow = async ($: EngineInterface) => {
  await update($, compacting, () => true)

  try {
    await $.command.run({ command: 'compact' })
  } catch {
    $.ui.toast('Compact не вдалося запустити')
  } finally {
    await update($, compacting, () => false)
  }
}

// A refused name must not stop the timer and the readings that follow.
const registerCommand = async ($: EngineInterface) => {
  try {
    await $.command.register({
      name: COMMAND,
      description: 'Показати або сховати смугу з контекстом і лімітами',
      immediate: true,
    })
  } catch {
    $.ui.toast(`/${COMMAND} не вдалося зареєструвати`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => update($, tick, n => n + 1))
    await update($, compacting, () => false)
    await registerCommand($)

    const usage = await $.session.usage()
    await update($, limits, () => toLimits(usage.rateLimits))
    await update($, context, () => toContextFill(usage.context))

    return next(e)
  })

  // The same switch the close button throws, so `/limits` brings a closed band
  // back and hides an open one.
  on('command.run', { command: COMMAND }, async $ => {
    const isNowHidden = !(await read($, hidden))

    await update($, hidden, () => isNowHidden)

    return {
      text: isNowHidden
        ? 'Смугу з лімітами сховано. /limits повертає її.'
        : 'Смугу з лімітами показано.',
    }
  }).catch(() => ({ text: 'Не вдалося перемкнути смугу з лімітами.' }))

  // Every compaction leaves the context smaller: the button's, a typed
  // /compact and the automatic one alike. A subagent's own does not count.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (e.trigger !== 'precompute' && e.agentId === undefined && result.skip === undefined) {
      $.clock.after(COMPACTION_SETTLE_MS, () => {
        void refreshAfterCompaction($, result.tokensAfter)
      })
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await update($, limits, () => toLimits(e.rateLimits))
    // Just after a compaction the engine has no context figure until the next
    // response, and the last estimate is kept rather than blanked.
    await update($, context, fill => toContextFill(e.context) ?? fill)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick)

    const now = await $.clock.now()
    const isBusy = await read($, compacting)
    const isHidden = await read($, hidden)
    const segments = toSegments(await read($, context), await read($, limits), now)

    if (e.props.hasSurvey || isHidden || segments.length === 0) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const hasContext = segments.some(segment => segment.key === 'context')

    const drawSegment = ({ key, label, percent, color, detail }: Segment) => (
      <Text key={key}>
        {`${label} `}
        <Text color={color} mono>
          {`${drawBar(percent)} `}
        </Text>
        <Text color={color} mono>
          {`${Math.round(percent)}%`}
        </Text>
        {detail === '' ? null : <Text dimColor>{` ${detail}`}</Text>}
      </Text>
    )

    const separator = (index: number) => (
      <Text key={`separator-${index}`} dimColor>
        {SEPARATOR}
      </Text>
    )

    // The icon stands for the context beside it, which stays plain coloured
    // text: the desktop draws a Button's children without their colours.
    // Pressed during a turn it only toasts, as the compaction is refused.
    const drawCompact = () =>
      isBusy ? (
        <Text dimColor>⏳</Text>
      ) : (
        <Button
          key="compact"
          label={COMPACT_ICON}
          dimColor
          onPress={() => {
            void compactNow($)
          }}
        />
      )

    // The outer row spans the band and the left part grows into the room that
    // is left, which puts the close button at the band's right edge.
    return (
      <Box flexDirection="row" alignItems="center" columnGap="sm" width="100%">
        <Box
          flexDirection="row"
          alignItems="center"
          columnGap="sm"
          flexGrow={1}
          flexShrink={1}
        >
          {hasContext ? drawCompact() : null}
          {/* One Text, so the segments keep a single row on every surface. */}
          <Text wrap="truncate-end">
            {segments.flatMap((segment, index) =>
              index === 0
                ? [drawSegment(segment)]
                : [separator(index), drawSegment(segment)],
            )}
          </Text>
        </Box>
        {/* The desktop draws a dismiss Button as a close control. It hides the
            band in this chat only: the state is the session's, so a new chat
            shows it again. */}
        <Button
          key="close"
          role="dismiss"
          label={CLOSE_ICON}
          dimColor
          onPress={() => {
            void update($, hidden, () => true)
          }}
        />
      </Box>
    )
  })
}
