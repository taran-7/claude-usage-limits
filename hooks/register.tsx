import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderSurface,
  SessionAppendMessage,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { ContextFill, Handover, LimitWindow, Limits } from '../types'

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
const COMPACT_ICON = '♻️'
const HANDOVER_ICON = '🤝'
const COPY_ICON = '📋'
const CLOSE_ICON = '×'
const HANDOVER_DIR = '.claude/handovers'
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
const IDLE: Handover = { phase: 'idle' }

const handover = atom(
  { plugin: 'usage-limits', key: 'handover' } as const,
  IDLE,
)
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
const refreshContext = async ($: EngineInterface) => {
  try {
    const { context: usage } = await $.session.usage({ breakdown: 'summary' })
    const fill =
      toContextFill(usage) ??
      toContextFill({ window: usage.window, tokens: usage.breakdown?.totalTokens })

    if (fill !== null) {
      await update($, context, () => fill)
    }
  } catch {
    // The bar is a convenience: the next response reports the real figure.
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

// Named by the minute it was asked for, in UTC so that the name does not
// depend on the machine's zone.
const handoverPath = (cwd: string, now: number): string => {
  const stamp = new Date(now).toISOString()
  const day = stamp.slice(0, 10)
  const minute = `${stamp.slice(11, 13)}${stamp.slice(14, 16)}`

  return `${cwd.replace(/\/+$/, '')}/${HANDOVER_DIR}/handover-${day}-${minute}.md`
}

const handoverPrompt = (path: string): string =>
  [
    'Write a handover document for another Claude session that will continue this work without access to this chat.',
    '',
    `Save it as a Markdown file at ${path}. Create the folder if it is missing. Use the Write tool. Do not commit or push it.`,
    '',
    'Use only this conversation and what was verified in it. Do not invent anything. Where something is not known, write "unknown".',
    '',
    'Structure:',
    '',
    '# Handover: <topic>',
    '',
    '## Goal',
    'What the user wants and why, in their terms.',
    '',
    '## Current state',
    'Done, in progress, not started. Name branches, PRs and commits.',
    '',
    '## Decisions and constraints',
    "Each decision with its reason. Include the user's rules and preferences, quoting the important ones verbatim, and what was ruled out and why.",
    '',
    '## Key facts',
    'Exact file paths, commands, versions, IDs and URLs the next session needs, and how to run or test the work.',
    '',
    '## Tried and failed',
    'Approaches that did not work and the cause, so they are not repeated.',
    '',
    '## Open questions and risks',
    'What is undecided or unverified.',
    '',
    '## Next steps',
    'An ordered list. The first step must be doable at once.',
    '',
    '## Start here',
    'One short paragraph for the next session to read first, and the files to open first.',
    '',
    'Rules: write in the language the user writes in. No secrets, tokens or passwords. Keep it under about 150 lines. Prefer facts over narrative. Do not use the em dash character.',
    '',
    'When the file is written, reply with only its absolute path and a three-line summary.',
  ].join('\n')

// What the person pastes as the first message of the next session.
const handoverLine = (path: string): string =>
  `Read ${path} first. It is a handover from another session. Continue from its "Next steps".`

// Asks the model to write the handover to a path chosen here, so the path is
// known without reading the reply. The prompt is queued until the session is
// idle; `isBusy` says a turn is running now, whose end is not the handover's.
const startHandover = async ($: EngineInterface, isBusy: boolean) => {
  try {
    const path = handoverPath(await $.session.cwd(), await $.clock.now())

    await update($, handover, (): Handover => ({ phase: 'writing', path, skip: isBusy ? 1 : 0 }))

    const result = await $.prompt
      .submit({ text: handoverPrompt(path), asUser: true })
      .catch(() => ({ drop: 'failed' }))

    if (result.drop !== undefined) {
      await update($, handover, (): Handover => IDLE)
      $.ui.toast('Handover could not be started')
    }
  } catch {
    $.ui.toast('Handover could not be started')
  }
}

// At the end of the handover's own turn the file is there, or it is not.
const settleHandover = async ($: EngineInterface) => {
  const state = await read($, handover)

  if (state.phase !== 'writing') return

  if (state.skip > 0) {
    await update($, handover, (): Handover => ({ ...state, skip: state.skip - 1 }))
    return
  }

  const isWritten = await $.fs.exists(state.path).catch(() => false)

  await update($, handover, (): Handover => (isWritten ? { phase: 'ready', path: state.path } : IDLE))
  $.ui.toast(
    isWritten
      ? `Handover saved. ${COPY_ICON} copies the line for the next session.`
      : 'The handover file was not written',
  )
}

const copyHandoverLine = async ($: EngineInterface, path: string, surface: RenderSurface) => {
  const isCopied = await $.ui
    .copy({ text: handoverLine(path), surface })
    .then(result => result.isCopied)
    .catch(() => false)

  $.ui.toast(isCopied ? 'Handover line copied' : 'Could not copy the handover line')
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
    await update($, handover, (): Handover => IDLE)
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

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      await settleHandover($)
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
    const handing = await read($, handover)
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

    // The handover asks the model to write the file, so it works as `compact`
    // does: an hourglass while it runs, then a second button copies the line
    // that points the next session at the file.
    const drawHandover = () => {
      if (handing.phase === 'writing') {
        return [<Text key="handover" dimColor>⏳</Text>]
      }

      const handoverButton = (
        <Button
          key="handover"
          label={HANDOVER_ICON}
          dimColor
          onPress={() => {
            void startHandover($, e.props.isWorking)
          }}
        />
      )

      if (handing.phase !== 'ready') return [handoverButton]

      const { path } = handing

      return [
        handoverButton,
        <Button
          key="copy-handover"
          label={COPY_ICON}
          dimColor
          onPress={press => {
            void copyHandoverLine($, path, press.surface)
          }}
        />,
      ]
    }

    // The outer row spans the band: the compact and handover buttons at its
    // left edge, the close button at its right, and the readings centred in
    // the room between.
    return (
      <Box flexDirection="row" alignItems="center" columnGap="sm" width="100%">
        <Box flexDirection="row" alignItems="center" columnGap="sm">
          {hasContext ? drawCompact() : null}
          {drawHandover()}
        </Box>
        <Box
          flexDirection="row"
          alignItems="center"
          justifyContent="center"
          flexGrow={1}
          flexShrink={1}
        >
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
