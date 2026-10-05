export type EpochMs = number

export type RateLimit = {
  kind: string
  percentUsed: number
  resetsAt: EpochMs | null
}

export type CacheCountdown = {
  sentAt: EpochMs
  estimated: boolean
}

export type CreditsReading = {
  percentUsed: number | null
  requestedAt: EpochMs
  requestId: string | null
  pendingSince: EpochMs | null
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
      cache: CacheCountdown | null
      snapshot: SessionSnapshot | null
      credits: CreditsReading | null
    }
  }
}
