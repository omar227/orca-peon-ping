export type PlayableCategory =
  | 'session.start'
  | 'task.acknowledge'
  | 'input.required'
  | 'task.complete'
  | 'task.error'

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

export type TurnOutcome =
  | 'success'
  | 'failure'
  | 'cancellation'
  | 'superseded'
  | 'interruption'
  | 'unconfirmed'

export type AgentStatusEvent = {
  paneKey: string
  state: AgentState
  sessionId?: string
  title?: string
  workspaceId?: string | null
  receivedAt?: number
  mainAgent?: { state: AgentState; outcome?: TurnOutcome; stateStartedAt?: number }
}

type PaneRecord = {
  state: AgentState
  sessionId?: string
  seenAt: number
}

export class PaneTracker {
  #panes = new Map<string, PaneRecord>()
  #ttlMs: number
  #maxPanes: number
  #now: () => number

  constructor(options?: { ttlMs?: number; maxPanes?: number; now?: () => number }) {
    this.#ttlMs = options?.ttlMs ?? 3_600_000
    this.#maxPanes = options?.maxPanes ?? 500
    this.#now = options?.now ?? Date.now
  }

  get size(): number {
    return this.#panes.size
  }

  observe(event: AgentStatusEvent): PlayableCategory | null {
    const now = this.#now()
    this.#evictExpired(now)

    const prior = this.#panes.get(event.paneKey)
    const isNewSession = !prior || prior.sessionId !== event.sessionId
    const category = this.#categorize(event, prior, isNewSession)

    this.#panes.set(event.paneKey, {
      state: event.state,
      sessionId: event.sessionId,
      seenAt: now
    })
    this.#evictOverflow()

    return category
  }

  #categorize(
    event: AgentStatusEvent,
    prior: PaneRecord | undefined,
    isNewSession: boolean
  ): PlayableCategory | null {
    if (isNewSession) {
      if (event.state === 'done') return this.#doneCategory(event)
      if (event.state === 'blocked' || event.state === 'waiting') return 'input.required'
      return 'session.start'
    }

    if (prior && prior.state === event.state) return null

    switch (event.state) {
      case 'working':
        return 'task.acknowledge'
      case 'blocked':
      case 'waiting':
        return 'input.required'
      case 'done':
        return this.#doneCategory(event)
      default:
        return null
    }
  }

  /** Absent outcome errs toward playing the completion sound; only an explicit
   *  cancellation, interruption, superseded or unconfirmed turn stays silent. */
  #doneCategory(event: AgentStatusEvent): PlayableCategory | null {
    const outcome = event.mainAgent?.outcome
    if (outcome === undefined || outcome === 'success') return 'task.complete'
    if (outcome === 'failure') return 'task.error'
    return null
  }

  #evictExpired(now: number): void {
    for (const [paneKey, record] of this.#panes) {
      if (now - record.seenAt > this.#ttlMs) this.#panes.delete(paneKey)
    }
  }

  #evictOverflow(): void {
    while (this.#panes.size > this.#maxPanes) {
      let oldestKey: string | undefined
      let oldestSeenAt = Infinity
      for (const [paneKey, record] of this.#panes) {
        if (record.seenAt < oldestSeenAt) {
          oldestSeenAt = record.seenAt
          oldestKey = paneKey
        }
      }
      if (oldestKey === undefined) break
      this.#panes.delete(oldestKey)
    }
  }
}
