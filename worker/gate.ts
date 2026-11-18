import type { PlayableCategory } from './mapping.ts'

const PREEMPTING_CATEGORY: PlayableCategory = 'input.required'

export class SoundGate {
  private readonly globalFloorMs: number
  private readonly categoryDebounceMs: number
  private readonly now: () => number

  private lastSoundAt = -Infinity
  private readonly lastByCategory = new Map<PlayableCategory, number>()

  constructor(options?: {
    globalFloorMs?: number
    categoryDebounceMs?: number
    now?: () => number
  }) {
    this.globalFloorMs = options?.globalFloorMs ?? 500
    this.categoryDebounceMs = options?.categoryDebounceMs ?? 500
    this.now = options?.now ?? Date.now
  }

  allow(category: PlayableCategory): boolean {
    const now = this.now()

    const lastForCategory = this.lastByCategory.get(category)
    if (lastForCategory !== undefined && now - lastForCategory < this.categoryDebounceMs) {
      return false
    }

    const bypassesGlobalFloor = category === PREEMPTING_CATEGORY
    if (!bypassesGlobalFloor && now - this.lastSoundAt < this.globalFloorMs) {
      return false
    }

    this.lastByCategory.set(category, now)
    this.lastSoundAt = now
    return true
  }
}
