import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registryCachePath } from './paths.ts'

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

export type RegistryCache = { fetchedAt: number; index: RegistryIndex }

function asRegistryIndex(parsed: unknown): RegistryIndex {
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

export function parseRegistryIndex(text: string): RegistryIndex {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('registry index is not valid JSON')
  }
  return asRegistryIndex(parsed)
}

/**
 * The cache the plugin keeps between runs. It is a file rather than a `storage:own` value
 * because Orca caps one stored value at `PLUGIN_STORAGE_VALUE_MAX_BYTES` (256 KiB, see
 * out/shared/plugins/workers/plugin-host-api-storage-schemas.js) and the real index is
 * ~540 KB across 382 packs — over twice the cap, so `storage.set` rejected it outright and
 * that rejection escaped into whatever asked for the pack list. The worker is a real Node
 * process, so the file sits beside the packs in `~/.openpeon/` with no size limit at all.
 */
export type RegistryCacheIo = {
  /** The cached index, or null when there is none. May throw; the client treats that as none. */
  read(): RegistryCache | null
  /** Replaces the cache. May throw; the client logs it and carries on. */
  write(value: RegistryCache): void
}

function parseRegistryCache(text: string): RegistryCache {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('registry cache is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('registry cache must be a JSON object')
  }
  const cache = parsed as Partial<RegistryCache>
  if (typeof cache.fetchedAt !== 'number' || !Number.isFinite(cache.fetchedAt)) {
    throw new Error('registry cache has no fetch timestamp')
  }
  return { fetchedAt: cache.fetchedAt, index: asRegistryIndex(cache.index) }
}

/**
 * Reads and writes `~/.openpeon/registry-cache.json`. The write is a temp file in the same
 * directory followed by a rename, so a crash mid-write cannot leave a half-written file that
 * the next start then has to parse.
 */
export function fileRegistryCache(home?: string): RegistryCacheIo {
  const path = registryCachePath(home)
  return {
    read(): RegistryCache | null {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw error
      }
      return parseRegistryCache(text)
    },
    write(value: RegistryCache): void {
      const dir = dirname(path)
      mkdirSync(dir, { recursive: true })
      const temp = join(dir, `.registry-cache-${process.pid}-${Date.now()}.tmp`)
      try {
        writeFileSync(temp, JSON.stringify(value))
        renameSync(temp, path)
      } catch (error) {
        rmSync(temp, { force: true })
        throw error
      }
    }
  }
}

export type RegistryResult = {
  index: RegistryIndex | null
  fetchedAt: number | null
  stale: boolean
  error: string | null
}

export type RegistryClientOptions = {
  fetchImpl?: typeof fetch
  now?: () => number
  /** Where `~/.openpeon/` lives; tests point it at a temp directory. */
  home?: string
  /** Overrides the on-disk cache, for tests that need reads or writes to fail. */
  cache?: RegistryCacheIo
  log?: (message: string) => void
}

export class RegistryClient {
  readonly #fetchImpl: typeof fetch
  readonly #now: () => number
  readonly #cache: RegistryCacheIo
  readonly #log: (message: string) => void

  constructor(options?: RegistryClientOptions) {
    this.#fetchImpl = options?.fetchImpl ?? fetch
    this.#now = options?.now ?? Date.now
    this.#cache = options?.cache ?? fileRegistryCache(options?.home)
    this.#log = options?.log ?? (() => {})
  }

  /**
   * Never throws, for any reason. Everything it can fail at — the network, the registry's
   * own JSON, reading the cache, writing the cache — degrades to a result, because the
   * callers are the pack list and the panel push: a throw here is a user who sees no packs
   * and hears no sounds, which is the one failure this plugin exists to avoid.
   */
  async load(options?: { force?: boolean }): Promise<RegistryResult> {
    const cached = this.#readCache()
    try {
      return await this.#refresh(cached, options?.force === true)
    } catch (error) {
      // Nothing below is expected to throw; if something does, the cache still answers.
      this.#log(`registry load failed unexpectedly: ${messageOf(error)}`)
      return {
        index: cached?.index ?? null,
        fetchedAt: cached?.fetchedAt ?? null,
        stale: cached !== null,
        error: messageOf(error)
      }
    }
  }

  async #refresh(cached: RegistryCache | null, force: boolean): Promise<RegistryResult> {
    const now = this.#now()
    const isFresh = cached !== null && now - cached.fetchedAt < REGISTRY_TTL_MS

    if (isFresh && !force) {
      return { index: cached.index, fetchedAt: cached.fetchedAt, stale: false, error: null }
    }

    let response: Response
    try {
      response = await this.#fetchImpl(REGISTRY_URL)
    } catch (err) {
      return this.#fallback(cached, `failed to fetch registry: ${messageOf(err)}`)
    }

    if (!response.ok) {
      return this.#fallback(cached, `registry responded with ${response.status}`)
    }

    let index: RegistryIndex
    try {
      const text = await response.text()
      index = parseRegistryIndex(text)
    } catch (err) {
      return this.#fallback(cached, messageOf(err))
    }

    const fetchedAt = now
    this.#writeCache({ fetchedAt, index })
    return { index, fetchedAt, stale: false, error: null }
  }

  #fallback(cached: RegistryCache | null, error: string): RegistryResult {
    return {
      index: cached?.index ?? null,
      fetchedAt: cached?.fetchedAt ?? null,
      stale: cached !== null,
      error
    }
  }

  /** A cache that cannot be read — missing, truncated, or anything else — is simply no cache. */
  #readCache(): RegistryCache | null {
    try {
      return this.#cache.read()
    } catch (error) {
      this.#log(`ignoring an unusable registry cache: ${messageOf(error)}`)
      return null
    }
  }

  /** A cache that cannot be written is slow, not broken: the index just fetched still stands. */
  #writeCache(value: RegistryCache): void {
    try {
      this.#cache.write(value)
    } catch (error) {
      this.#log(`could not save the registry cache: ${messageOf(error)}`)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
