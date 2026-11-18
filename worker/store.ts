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
    const value = await this.#api.get<Record<string, InstalledPack>>(KEYS.installedPacks)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {}
    }
    return value
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
    const lastPlayed = await this.#api.get<Record<string, string>>(KEYS.lastPlayed)
    return lastPlayed?.[category] ?? null
  }

  async setLastPlayed(category: PlayableCategory, file: string): Promise<void> {
    const lastPlayed = (await this.#api.get<Record<string, string>>(KEYS.lastPlayed)) ?? {}
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
