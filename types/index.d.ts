export type LimitWindow = {
  /** 0 to 100, as the rate-limit notices read it. */
  percentUsed: number
  /** ISO 8601 timestamp of the reset, when the API reported one. */
  resetsAt: string | null
}

export type Limits = {
  /** The five-hour session window. */
  session: LimitWindow | null
  /** The seven-day weekly window. */
  week: LimitWindow | null
}

export type ContextFill = {
  /** How much of the context window the last response filled, 0 to 100. */
  percent: number
  /** Input tokens the last response was answered over, when reported. */
  tokens: number | null
  /** The model's context window, in tokens. */
  window: number
}

export type Handover =
  | { phase: 'idle' }
  /** The model is writing the file at `path`; `skip` counts the turns that end first. */
  | { phase: 'writing'; path: string; skip: number }
  /** The file at `path` is written. */
  | { phase: 'ready'; path: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': {
      limits: Limits
      /** The live context window of this session; null before a reading. */
      context: ContextFill | null
      /** True while a compaction started from the context button runs. */
      isCompacting: boolean
      /** Where the handover started from the button stands. */
      handover: Handover
      /** True once the person closed the band in this chat. */
      isHidden: boolean
      /** Bumped by a timer so the countdown redraws between API responses. */
      tick: number
    }
  }
}
