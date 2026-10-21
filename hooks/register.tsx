import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { ContextFill, LimitWindow, Limits } from '../types'

const TICK_MS = 30_000
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WARNING_AT = 70
const ERROR_AT = 90
const BAR_WIDTH = 10
const SEPARATOR = '  ·  '

type Segment = {
  key: string
  label: string
  percent: number
  detail: string
}

const limits = atom(
  { plugin: 'usage-limits', key: 'limits' } as const,
  { session: null, week: null },
)
const context = atom({ plugin: 'usage-limits', key: 'context' } as const, null)
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
      detail: describeContext(fill),
    })
  }
  if (session !== null) {
    segments.push({
      key: 'session',
      label: 'Сесія',
      percent: session.percentUsed,
      detail: describeReset(session, now),
    })
  }
  if (week !== null) {
    segments.push({
      key: 'week',
      label: 'Тиждень',
      percent: week.percentUsed,
      detail: describeReset(week, now),
    })
  }

  return segments
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => update($, tick, n => n + 1))

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
    const segments = toSegments(await read($, context), await read($, limits), now)

    if (e.props.hasSurvey || segments.length === 0) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)

    const drawSegment = ({ key, label, percent, detail }: Segment) => (
      <Text key={key}>
        {`${label} `}
        <Text key={`${key}-bar`} color={pickColor(percent)} mono>
          {`${drawBar(percent)} `}
        </Text>
        <Text key={`${key}-percent`} color={pickColor(percent)} mono>
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

    // One Text, so every surface keeps it on a single row.
    return (
      <Text wrap="truncate-end">
        {segments.flatMap((segment, index) =>
          index === 0 ? [drawSegment(segment)] : [separator(index), drawSegment(segment)],
        )}
      </Text>
    )
  })
}
