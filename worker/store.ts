import type { PlayableCategory } from './mapping.ts'

const KEYS = {
  activePack: 'activePack',
  installedPacks: 'installedPacks',
  lastPlayed: 'lastPlayed',
  firstRunDone: 'firstRunDone'
} as const

export type InstalledPack = {
  name: string
  version: string | null
  sourceRef: string | null
  manifestSha256: string | null
  installedAt: number
  adopted: boolean
}

export type StoreApi = {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
}

/**
 * Anything in the store may be whatever a previous version — or a corrupted value — left there,
 * so every keyed map is read through this: a non-object reads back as empty rather than throwing
 * somewhere far away from the cause.
 */
function asRecord<T>(value: unknown): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, T>
}

export class Store {
  readonly #api: StoreApi

  constructor(api: StoreApi) {
    this.#api = api
  }

  async getActivePack(): Promise<string | null> {
    return this.#api.get<string>(KEYS.activePack)
  }

  async setActivePack(name: string | null): Promise<void> {
    await this.#api.set(KEYS.activePack, name)
  }

  async getInstalled(): Promise<Record<string, InstalledPack>> {
    return asRecord<InstalledPack>(await this.#api.get(KEYS.installedPacks))
  }

  async recordInstalled(pack: InstalledPack): Promise<void> {
    const installed = await this.getInstalled()
    installed[pack.name] = pack
    await this.#api.set(KEYS.installedPacks, installed)
  }

  async forgetInstalled(name: string): Promise<void> {
    const installed = await this.getInstalled()
    delete installed[name]
    await this.#api.set(KEYS.installedPacks, installed)
  }

  async getLastPlayed(category: PlayableCategory): Promise<string | null> {
    const last = asRecord<string>(await this.#api.get(KEYS.lastPlayed))[category]
    return typeof last === 'string' ? last : null
  }

  async setLastPlayed(category: PlayableCategory, file: string): Promise<void> {
    const lastPlayed = asRecord<string>(await this.#api.get(KEYS.lastPlayed))
    lastPlayed[category] = file
    await this.#api.set(KEYS.lastPlayed, lastPlayed)
  }

  async isFirstRunDone(): Promise<boolean> {
    return (await this.#api.get<boolean>(KEYS.firstRunDone)) ?? false
  }

  async markFirstRunDone(): Promise<void> {
    await this.#api.set(KEYS.firstRunDone, true)
  }
}
