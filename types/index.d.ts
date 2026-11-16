export type TokRateSource = {
  /** 'main' or the subagent id. */
  id: string
  /** 'main' or the agent type. */
  label: string
  model: string
  /** Rate of the last completed call, or null. */
  last: number | null
  /** Rates of the last 10 completed calls. */
  recent: number[]
  /** Live estimate while streaming (4 characters per token), or null. */
  live: number | null
  /** Milliseconds from request start to first token, last call. */
  ttftMs: number | null
  calls: number
  status: 'streaming' | 'idle' | 'done'
}

declare module 'claude-code' {
  interface PluginState {
    'tok-rate': { sources: Shaped<Record<string, TokRateSource>> }
  }
}
