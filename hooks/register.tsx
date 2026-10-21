import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionCompactResult,
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
const BAR_WIDTH = 10
// The context is judged on the percent as it is shown: green up to 40, yellow
// 41 to 60, dark red from 61. The limits keep WARNING_AT and ERROR_AT.
const CONTEXT_GREEN_UNTIL = 40
const CONTEXT_YELLOW_UNTIL = 60
const DARK_RED = '#b91c1c'
const SEPARATOR = '  ·  '

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

const describeCompaction = (result: SessionCompactResult): string => {
  if (result.skip !== undefined) return `Compact скасовано: ${result.skip}`
  if (result.tokensBefore === undefined || result.tokensAfter === undefined) {
    return 'Контекст стиснуто'
  }

  return `Контекст стиснуто: ${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)}`
}

const showCompacted = async ($: EngineInterface, result: SessionCompactResult) => {
  if (result.skip === undefined && result.tokensAfter !== undefined) {
    const tokens = result.tokensAfter

    // The engine measures again after the next response; until then the
    // compaction's own figure is the best reading there is.
    await update($, context, fill =>
      fill === null ? null : toContextFill({ window: fill.window, tokens }),
    )
  }

  $.ui.toast(describeCompaction(result))
}

// The same call `/compact` makes. It rejects while a turn runs.
const compactNow = async ($: EngineInterface) => {
  await update($, compacting, () => true)
  $.ui.toast('Стискаю контекст…')

  try {
    await showCompacted($, await $.session.compact())
  } catch {
    $.ui.toast('Compact неможливий, поки триває відповідь')
  } finally {
    await update($, compacting, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => update($, tick, n => n + 1))
    await update($, compacting, () => false)

    const usage = await $.session.usage()
    await update($, limits, () => toLimits(usage.rateLimits))
    await update($, context, () => toContextFill(usage.context))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, limits, () => toLimits(e.rateLimits))
    await update($, context, () => toContextFill(e.context))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick)

    const now = await $.clock.now()
    const isBusy = await read($, compacting)
    const segments = toSegments(await read($, context), await read($, limits), now)

    if (e.props.hasSurvey || segments.length === 0) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const contextSegment = segments.find(segment => segment.key === 'context')
    const limitSegments = segments.filter(segment => segment.key !== 'context')

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

    // The context stays plain text next to the button: the desktop draws a
    // Button's children without their colours, and the bar is the colour.
    // Pressed during a turn it only toasts, as the compaction is refused.
    const drawCompact = () =>
      isBusy ? (
        <Text dimColor>стискаю…</Text>
      ) : (
        <Button
          key="compact"
          label="Стиснути"
          dimColor
          onPress={() => {
            void compactNow($)
          }}
        />
      )

    return (
      <Box flexDirection="row" alignItems="center" columnGap="sm">
        {contextSegment === undefined ? null : drawSegment(contextSegment)}
        {contextSegment === undefined ? null : drawCompact()}
        {contextSegment === undefined || limitSegments.length === 0 ? null : (
          <Text dimColor>·</Text>
        )}
        {limitSegments.length === 0 ? null : (
          // One Text, so the limits keep a single row on every surface.
          <Text wrap="truncate-end">
            {limitSegments.flatMap((segment, index) =>
              index === 0
                ? [drawSegment(segment)]
                : [separator(index), drawSegment(segment)],
            )}
          </Text>
        )}
      </Box>
    )
  })
}
