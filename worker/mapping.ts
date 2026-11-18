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
  /** Part of the dedup key, not decoration: `done` → `done` can change only the outcome. */
  outcome?: TurnOutcome
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
      outcome: event.mainAgent?.outcome,
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

    // Deduping on the state alone swallowed the one transition that matters most: Orca's codex
    // failure detector reports `done` with no outcome and then `done` with `outcome: "failure"`
    // for the same pane, so a failed agent played "Job's done!" and never played the error line.
    // The outcome is part of what makes a report distinct, so both are seen.
    //
    // `blocked` → `waiting` → `blocked` still re-fires `input.required`, deliberately: the
    // outcome is undefined throughout and the state really does change each time, and an agent
    // still waiting on a human is exactly what this plugin exists to keep saying. A burst inside
    // 500 ms collapses to one sound at the per-category gate.
    //
    // The trade this key makes, stated plainly: `done`+`success` followed by a bare `done` for
    // the same pane is two distinct reports, so `task.complete` plays twice. That is the right
    // side to err on — an absent outcome is common, not exceptional, and treating it as a repeat
    // would mean a finished agent that reports it that way goes silent, which is failure mode
    // number one. A doubled completion inside 500 ms is swallowed by the gate anyway.
    if (prior && prior.state === event.state && prior.outcome === event.mainAgent?.outcome) {
      return null
    }

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
