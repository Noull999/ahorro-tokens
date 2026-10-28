export type Effort = 'low' | 'medium' | 'high'

export type Activity = 'idle' | 'think' | 'read' | 'write' | 'run' | 'web' | 'agent' | 'done' | 'ask' | 'error'

export type Suggestion = { to: string; name: string; reason: string }

export type Usage = { tokens: number; window: number; percent: number; usd: number | null }

export type Limit = { kind: string; percent: number; resetsAt: string | null }

export type Omni = { model: string; calls: number; at: number }

export type Running = { agents: number; commands: number }

export type Spend =Record<string, { turns: number; usd: number }>

export type Extra = { budget: number; used: number }

declare module 'claude-code' {
  interface PluginState {
    'ahorro-tokens': {
      isOn: boolean
      switchModel: boolean
      promptEffort: Effort
      last: string | null
      suggestion: Suggestion | null
      isBusy: boolean
      showAvatar: boolean
      isThinking: boolean
      activity: Activity
      ideasOn: boolean
      idea: string | null
      usage: Usage | null
      limits: Limit[]
      spend: Spend
      omni: Omni | null
      costSeen: number
      ideaTurns: number
      running: Running
      edited: string[]
      compactOffered: boolean
      extra: Extra | null
    }
  }
}
