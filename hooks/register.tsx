import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderChildren,
  SessionAppendMessage,
  SessionContextUsage,
  SessionRateLimit,
  SessionUsage,
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
// The editor's theme leaves its `warning` colour unset, and a drawing cannot
// use a theme colour at all, so the editor gets its colours given outright.
const EDITOR_GREEN = '#25E712'
const EDITOR_YELLOW = '#ca8a04'
const EDITOR_RED = '#C1121C'
const RING_TRACK = 'rgba(140, 140, 140, 0.35)'
const RING_SIZE = 16
const RING_RADIUS = 6
const RING_STROKE = 2.5
// Below this many columns the rings and the text do not fit one line, and the
// editor draws the readings as text alone. The editor counts a column as the
// width of a box-drawing character in its own font, some 13 to 16 px, not as a
// monospace cell. 0 means the width is not known yet.
const EDITOR_RINGS_FROM = 32
const SEPARATOR = ' · '
const COMPACT_ICON = '♻️'
const REFRESH_ICON = '↻'
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

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${Math.max(minutes, 1)}m`
}

const describeContext = (fill: ContextFill): string =>
  fill.tokens === null
    ? `window ${formatTokens(fill.window)}`
    : `${formatTokens(fill.tokens)}/${formatTokens(fill.window)}`

const hasReset = (window: LimitWindow, now: number): boolean =>
  window.resetsAt !== null && Date.parse(window.resetsAt) <= now

const describeReset = (window: LimitWindow, now: number): string => {
  if (window.resetsAt === null) return ''

  return hasReset(window, now)
    ? 'just reset'
    : formatRemaining(Date.parse(window.resetsAt) - now)
}

// The engine reports a limit only with a response, so a window that has reset
// since still carries the reading from before. It starts again from nothing.
const usedNow = (window: LimitWindow, now: number): number =>
  hasReset(window, now) ? 0 : window.percentUsed

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

const editorColor = (color: string): string => {
  if (color === 'success') return EDITOR_GREEN
  if (color === 'warning') return EDITOR_YELLOW
  if (color === 'error' || color === DARK_RED) return EDITOR_RED
  return color
}

// A ring that fills clockwise from the top, as a drawing: the editor's font
// does not keep the blocks of a text bar to one width.
const drawRing = (percent: number, color: string): string => {
  const circumference = 2 * Math.PI * RING_RADIUS
  const filled = (Math.min(Math.max(percent, 0), 100) * circumference) / 100
  const centre = RING_SIZE / 2
  const circle = (stroke: string, extra = '') =>
    `<circle cx="${centre}" cy="${centre}" r="${RING_RADIUS}" fill="none" stroke="${stroke}" stroke-width="${RING_STROKE}"${extra}/>`
  const arc =
    filled > 0
      ? circle(
          color,
          ` stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 ${centre} ${centre})"`,
        )
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RING_SIZE}" height="${RING_SIZE}" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">${circle(RING_TRACK)}${arc}</svg>`
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
      label: 'Context',
      percent: fill.percent,
      color: pickContextColor(fill.percent),
      detail: describeContext(fill),
    })
  }
  if (session !== null) {
    const percent = usedNow(session, now)

    segments.push({
      key: 'session',
      label: 'Session',
      percent,
      color: pickColor(percent),
      detail: describeReset(session, now),
    })
  }
  if (week !== null) {
    const percent = usedNow(week, now)

    segments.push({
      key: 'week',
      label: 'Week',
      percent,
      color: pickColor(percent),
      detail: describeReset(week, now),
    })
  }

  return segments
}

// What the context is worth once a compaction is done. The engine reports its
// own figure only with the next response, so until then its estimate of the
// live transcript is the best reading there is.
// The figure the engine reports, or else its estimate of the live transcript.
const fillFrom = (usage: SessionUsage): ContextFill | null =>
  toContextFill(usage.context) ??
  toContextFill({ window: usage.context.window, tokens: usage.context.breakdown?.totalTokens })

const refreshContext = async ($: EngineInterface) => {
  try {
    const fill = fillFrom(await $.session.usage({ breakdown: 'summary' }))

    if (fill !== null) {
      await update($, context, () => fill)
    }
  } catch {
    // The bar is a convenience: the next response reports the real figure.
  }
}

// A window the engine has no reading for keeps the one the row already has.
const mergeLimits = (held: Limits, latest: Limits): Limits => ({
  session: latest.session ?? held.session,
  week: latest.week ?? held.week,
})

// Asks the engine for everything it knows now. The limits are the last ones a
// response reported, so a press brings the countdowns and the context up to
// date, not a figure the account has not been sent yet.
const refreshReadings = async ($: EngineInterface) => {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const fill = fillFrom(usage)

    await update($, limits, held => mergeLimits(held, toLimits(usage.rateLimits)))
    if (fill !== null) {
      await update($, context, () => fill)
    }
    $.ui.toast('Readings refreshed')
  } catch {
    $.ui.toast('Could not refresh the readings')
  }
}

// Straight after a compaction the estimate has not counted the new
// conversation in full yet, and it settles within a second or two.
const refreshSoon = ($: EngineInterface) => {
  $.clock.after(COMPACTION_SETTLE_MS, () => {
    void refreshContext($)
  })
}

// A compaction that nothing announced still shows: the engine has no figure
// for the context until the next response, while the bar still has the old one.
const catchUpWithCompaction = async ($: EngineInterface) => {
  if ((await read($, context)) === null) return

  try {
    const { context: usage } = await $.session.usage()

    if (usage.tokens === undefined) {
      await refreshContext($)
    }
  } catch {
    // The next tick tries again.
  }
}

// What a finished /compact leaves in the conversation: the command and its
// output, as the engine wraps them.
const COMPACT_ROW = /<command-name>\/?compact<\/command-name>|<local-command-stdout>\s*Compacted/

const isCompactRow = ({ content }: SessionAppendMessage): boolean =>
  content.some(block => block.type === 'text' && COMPACT_ROW.test(String(block.text)))

// Runs the real `/compact`, so it shows in the chat as if it were typed. It is
// queued until the session is idle, so a press during a turn is not lost.
const compactNow = async ($: EngineInterface) => {
  await update($, compacting, () => true)

  try {
    await $.command.run({ command: 'compact' })
    refreshSoon($)
  } catch {
    $.ui.toast('Compact could not be started')
  } finally {
    await update($, compacting, () => false)
  }
}

// A refused name must not stop the timer and the readings that follow.
const registerCommand = async ($: EngineInterface) => {
  try {
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the row with the context and the limits',
      immediate: true,
    })
  } catch {
    $.ui.toast(`/${COMMAND} could not be registered`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => {
      void catchUpWithCompaction($)

      return update($, tick, n => n + 1)
    })
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
        ? 'The limits row is hidden. /limits brings it back.'
        : 'The limits row is shown.',
    }
  }).catch(() => ({ text: 'Could not toggle the limits row.' }))

  // Every compaction leaves the context smaller. A subagent's own does not
  // count. Not every surface announces one here: the desktop's /compact does
  // not, and the rows it leaves in the conversation stand in for it below.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (e.trigger !== 'precompute' && e.agentId === undefined && result.skip === undefined) {
      refreshSoon($)
    }

    return result
  }).catch(($, e, next) => next(e))

  // The command's rows come once it is done, so a typed /compact is caught as
  // well as the button's.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && isCompactRow(e.message)) {
      refreshSoon($)
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

    // In the editor's panel the band is one small line in the caption size, with
    // no labels. The readings are rings beside the text when the band is wide
    // enough, else the text alone.
    const isEditor = e.surface === 'vscode'
    const Svg = e.surface === 'vscode' ? $.ui.resolve(e).Svg : null
    const columns = e.props.bodyColumns
    const hasRings = Svg !== null && (columns === 0 || columns >= EDITOR_RINGS_FROM)
    // The editor wraps a Text unless it says otherwise, and the parts inside the
    // one that truncates wrap on their own, so each says it.
    const textProps = isEditor
      ? { size: 'caption' as const, wrap: 'truncate-end' as const }
      : {}
    const tint = (color: string) => (isEditor ? editorColor(color) : color)

    const drawSegment = ({ key, label, percent, color, detail }: Segment) => (
      <Text key={key} {...textProps}>
        {isEditor ? null : `${label} `}
        {isEditor ? null : (
          <Text color={color} mono>
            {`${drawBar(percent)} `}
          </Text>
        )}
        <Text color={tint(color)} mono={!isEditor} {...textProps}>
          {`${Math.round(percent)}%`}
        </Text>
        {detail === '' ? null : (
          <Text dimColor {...textProps}>
            {` ${detail}`}
          </Text>
        )}
      </Text>
    )

    const drawRingSegment = ({ key, label, percent, color, detail }: Segment) =>
      Svg === null ? null : (
        <Box key={key} flexDirection="row" alignItems="center" columnGap="sm">
          <Svg
            key="ring"
            source={drawRing(percent, tint(color))}
            alt={`${label} ${Math.round(percent)}%`}
            width={RING_SIZE}
            height={RING_SIZE}
          />
          <Text wrap="truncate-end" {...textProps}>
            <Text color={tint(color)} {...textProps}>
              {`${Math.round(percent)}%`}
            </Text>
            {detail === '' ? null : (
              <Text dimColor {...textProps}>
                {` ${detail}`}
              </Text>
            )}
          </Text>
        </Box>
      )

    const separator = (index: number) => (
      <Text key={`separator-${index}`} dimColor {...textProps}>
        {SEPARATOR}
      </Text>
    )

    const joined = (draw: (segment: Segment) => RenderChildren) =>
      segments.flatMap((segment, index) =>
        index === 0 ? [draw(segment)] : [separator(index), draw(segment)],
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

    // The outer row spans the band: the compact button at its left edge, the
    // close button at its right, and the readings centred in the room between.
    return (
      <Box
        flexDirection="row"
        alignItems="center"
        columnGap="sm"
        width="100%"
        {...(isEditor ? { flexWrap: 'nowrap' as const } : {})}
      >
        <Box flexDirection="row" alignItems="center">
          {hasContext ? drawCompact() : null}
        </Box>
        <Box
          flexDirection="row"
          alignItems="center"
          justifyContent="center"
          flexGrow={1}
          flexShrink={1}
          {...(isEditor ? { minWidth: 0 } : {})}
        >
          {hasRings ? (
            <Box flexDirection="row" alignItems="center" columnGap="sm" flexWrap="nowrap" overflow="hidden">
              {joined(drawRingSegment)}
            </Box>
          ) : (
            // One Text, so the segments keep a single row on every surface.
            <Text wrap="truncate-end" {...textProps}>
              {joined(drawSegment)}
            </Text>
          )}
        </Box>
        <Button
          key="refresh"
          label={REFRESH_ICON}
          dimColor
          onPress={() => {
            void refreshReadings($)
          }}
        />
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
