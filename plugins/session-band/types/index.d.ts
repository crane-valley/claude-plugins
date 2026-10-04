export type EpochMs = number

export type RateLimit = {
  kind: string
  percentUsed: number
  resetsAt: EpochMs | null
}

export type SessionSnapshot = {
  startedAt: EpochMs
  percent: number | null
  tokens: number | null
  window: number
  top: { name: string; tokens: number; color: string }[]
  otherTokens: number
  limits: RateLimit[]
  costUsd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-band': {
      lastResponseAt: EpochMs | null
      snapshot: SessionSnapshot | null
    }
  }
}
