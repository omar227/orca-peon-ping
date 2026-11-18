import type { Store } from './store.ts'

export const REGISTRY_URL = 'https://peonping.github.io/registry/index.json'
export const REGISTRY_TTL_MS = 86_400_000

export type RegistryPack = {
  name: string
  display_name: string
  version: string
  description?: string
  author?: { name?: string; github?: string }
  trust_tier: 'official' | 'verified' | 'community'
  categories: string[]
  language: string
  license?: string
  sound_count: number
  total_size_bytes?: number
  source_repo: string
  source_ref: string
  source_path?: string
  manifest_sha256?: string
  tags?: string[]
  preview_sounds?: string[]
}

export type RegistryIndex = { version: number; packs: RegistryPack[] }

export function parseRegistryIndex(text: string): RegistryIndex {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('registry index is not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('registry index must be a JSON object')
  }

  const index = parsed as Partial<RegistryIndex>
  if (!Array.isArray(index.packs)) {
    throw new Error('registry index is missing a packs array')
  }
  if (index.version !== 1) {
    throw new Error(`registry index has unsupported version: ${String(index.version)}`)
  }

  return index as RegistryIndex
}

export type RegistryResult = {
  index: RegistryIndex | null
  fetchedAt: number | null
  stale: boolean
  error: string | null
}

export class RegistryClient {
  readonly #store: Store
  readonly #fetchImpl: typeof fetch
  readonly #now: () => number

  constructor(store: Store, options?: { fetchImpl?: typeof fetch; now?: () => number }) {
    this.#store = store
    this.#fetchImpl = options?.fetchImpl ?? fetch
    this.#now = options?.now ?? Date.now
  }

  async load(options?: { force?: boolean }): Promise<RegistryResult> {
    const cached = await this.#store.getRegistryCache()
    const now = this.#now()
    const isFresh = cached !== null && now - cached.fetchedAt < REGISTRY_TTL_MS

    if (isFresh && !options?.force) {
      return { index: cached.index, fetchedAt: cached.fetchedAt, stale: false, error: null }
    }

    let response: Response
    try {
      response = await this.#fetchImpl(REGISTRY_URL)
    } catch (err) {
      return {
        index: cached?.index ?? null,
        fetchedAt: cached?.fetchedAt ?? null,
        stale: cached !== null,
        error: `failed to fetch registry: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (!response.ok) {
      return {
        index: cached?.index ?? null,
        fetchedAt: cached?.fetchedAt ?? null,
        stale: cached !== null,
        error: `registry responded with ${response.status}`
      }
    }

    let index: RegistryIndex
    try {
      const text = await response.text()
      index = parseRegistryIndex(text)
    } catch (err) {
      return {
        index: cached?.index ?? null,
        fetchedAt: cached?.fetchedAt ?? null,
        stale: cached !== null,
        error: err instanceof Error ? err.message : String(err)
      }
    }

    const fetchedAt = now
    await this.#store.setRegistryCache({ fetchedAt, index })
    return { index, fetchedAt, stale: false, error: null }
  }
}
