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

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': {
      limits: Limits
      /** The live context window of this session; null before a reading. */
      context: ContextFill | null
      /** True while a compaction started from the context button runs. */
      isCompacting: boolean
      /** Bumped by a timer so the countdown redraws between API responses. */
      tick: number
    }
  }
}
