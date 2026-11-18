import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PACK_NAME_PATTERN, registryCachePath } from './paths.ts'

export const REGISTRY_URL = 'https://peonping.github.io/registry/index.json'
export const REGISTRY_TTL_MS = 86_400_000

/**
 * How long to leave an unreachable registry alone after a background refresh failed. A failed
 * refresh leaves the cache out of date, so the next `load()` would start another one — and every
 * `packs.changed` push calls `load()`, so without this the push and the refresh spin on each
 * other for as long as the network is down.
 */
export const BACKGROUND_RETRY_MS = 300_000

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

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * `preview_sounds` is not one shape in the live registry. 339 packs ship `string[]`, 40 ship
 * nothing usable, and three — `itysl`, `solid_snake` and `speaki` — ship `[{file, label}]`.
 * Those three used to throw a raw `ERR_INVALID_ARG_TYPE` out of the preview button.
 */
function previewSoundsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const files: string[] = []
  for (const item of value) {
    const direct = nonEmptyString(item)
    if (direct !== null) {
      files.push(direct)
      continue
    }
    if (typeof item === 'object' && item !== null) {
      const file = nonEmptyString((item as { file?: unknown }).file)
      if (file !== null) files.push(file)
    }
  }
  return files.length > 0 ? files : undefined
}

/**
 * One registry row, checked for the fields this plugin actually dereferences and left alone
 * everywhere else. A row that fails returns null and is dropped: the whole point of fetching the
 * registry at runtime is that new entries arrive without a plugin release, so one malformed row
 * — one `name` that `packDir` would refuse, say — may cost that row and nothing more. It used to
 * cost every user the entire pack list until the registry was fixed.
 */
function toRegistryPack(value: unknown): RegistryPack | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  const name = typeof row.name === 'string' && PACK_NAME_PATTERN.test(row.name) ? row.name : null
  const displayName = nonEmptyString(row.display_name)
  const version = nonEmptyString(row.version)
  const sourceRepo = nonEmptyString(row.source_repo)
  const sourceRef = nonEmptyString(row.source_ref)
  // Tolerated as whatever string the registry uses: an unknown tier should show up as a plain
  // badge, not delete the pack from everyone's list the day the registry adds one.
  const trustTier = nonEmptyString(row.trust_tier)
  const soundCount = typeof row.sound_count === 'number' && Number.isFinite(row.sound_count)

  if (
    name === null ||
    displayName === null ||
    version === null ||
    sourceRepo === null ||
    sourceRef === null ||
    trustTier === null ||
    !soundCount
  ) {
    return null
  }
  // Both go straight into a URL path, so neither may carry a separator or whitespace of its own.
  if (!/^[^\s/]+\/[^\s/]+$/.test(sourceRepo) || /\s/.test(sourceRef)) return null

  return {
    ...row,
    name,
    display_name: displayName,
    version,
    trust_tier: trustTier as RegistryPack['trust_tier'],
    sound_count: row.sound_count as number,
    source_repo: sourceRepo,
    source_ref: sourceRef,
    description: nonEmptyString(row.description) ?? undefined,
    source_path: nonEmptyString(row.source_path) ?? undefined,
    total_size_bytes:
      typeof row.total_size_bytes === 'number' && Number.isFinite(row.total_size_bytes)
        ? row.total_size_bytes
        : undefined,
    preview_sounds: previewSoundsOf(row.preview_sounds)
  }
}

function asRegistryIndex(parsed: unknown, log: (message: string) => void): RegistryIndex {
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

  const packs: RegistryPack[] = []
  for (const row of index.packs) {
    const pack = toRegistryPack(row)
    if (pack !== null) packs.push(pack)
  }
  const dropped = index.packs.length - packs.length
  if (dropped > 0) {
    log(`ignored ${dropped} of ${index.packs.length} registry entries the plugin cannot use`)
  }

  return { version: 1, packs }
}

export function parseRegistryIndex(
  text: string,
  log: (message: string) => void = () => {}
): RegistryIndex {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('registry index is not valid JSON')
  }
  return asRegistryIndex(parsed, log)
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
  return { fetchedAt: cache.fetchedAt, index: asRegistryIndex(cache.index, () => {}) }
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
  /** Called when a refresh running behind the panel has landed. */
  onRefreshed?: () => void
}

export class RegistryClient {
  readonly #fetchImpl: typeof fetch
  readonly #now: () => number
  readonly #cache: RegistryCacheIo
  readonly #log: (message: string) => void
  /**
   * Set by the worker once it exists, so a refresh that lands behind the panel can push the
   * new list rather than waiting for the panel to ask again.
   */
  onRefreshed: (() => void) | null
  #inFlight: Promise<void> | null = null
  #lastAttemptAt = Number.NEGATIVE_INFINITY
  #lastError: string | null = null

  constructor(options?: RegistryClientOptions) {
    this.#fetchImpl = options?.fetchImpl ?? fetch
    this.#now = options?.now ?? Date.now
    this.#cache = options?.cache ?? fileRegistryCache(options?.home)
    this.#log = options?.log ?? (() => {})
    this.onRefreshed = options?.onRefreshed ?? null
  }

  /**
   * Never throws, for any reason. Everything it can fail at — the network, the registry's
   * own JSON, reading the cache, writing the cache — degrades to a result, because the
   * callers are the pack list and the panel push: a throw here is a user who sees no packs
   * and hears no sounds, which is the one failure this plugin exists to avoid.
   *
   * It also never *waits* on the network when it has something to show. The design says it in
   * so many words — "Serve the cached copy immediately so the panel never blocks on the
   * network" — and a panel that waited for a 540 KB refresh is how the first open after a day
   * away became a `timeout` error screen. A cache past its TTL is served as it is and refreshed
   * behind the panel; `onRefreshed` pushes the result when it lands.
   */
  async load(options?: { force?: boolean }): Promise<RegistryResult> {
    const cached = this.#readCache()

    // Nothing to show, or the person pressed Refresh and is waiting for an answer.
    if (cached === null || options?.force === true) {
      return await this.#attempt(cached)
    }

    if (this.#now() - cached.fetchedAt >= REGISTRY_TTL_MS) this.#refreshInBackground()

    return {
      index: cached.index,
      fetchedAt: cached.fetchedAt,
      // Merely out of date is not `stale` to the panel: `stale` is "the worker tried and could
      // not", which is what the panel's "Showing the last pack list" warning means.
      stale: this.#lastError !== null,
      error: this.#lastError
    }
  }

  /** Resolves once any refresh running behind the panel has finished. */
  async settled(): Promise<void> {
    while (this.#inFlight !== null) await this.#inFlight
  }

  /** One refresh at a time, and not again straight away when the last one failed. */
  #refreshInBackground(): void {
    if (this.#inFlight !== null) return
    if (this.#now() - this.#lastAttemptAt < BACKGROUND_RETRY_MS) return

    this.#inFlight = (async () => {
      try {
        await this.#attempt(this.#readCache())
      } finally {
        this.#inFlight = null
      }
      try {
        this.onRefreshed?.()
      } catch (error) {
        this.#log(`could not announce a refreshed registry: ${messageOf(error)}`)
      }
    })()
  }

  /** One fetch attempt, whatever happens. Records why it failed, and never throws. */
  async #attempt(cached: RegistryCache | null): Promise<RegistryResult> {
    this.#lastAttemptAt = this.#now()
    let result: RegistryResult
    try {
      result = await this.#refresh(cached)
    } catch (error) {
      // Nothing below is expected to throw; if something does, the cache still answers.
      this.#log(`registry load failed unexpectedly: ${messageOf(error)}`)
      result = this.#fallback(cached, messageOf(error))
    }
    this.#lastError = result.error
    return result
  }

  async #refresh(cached: RegistryCache | null): Promise<RegistryResult> {
    const now = this.#now()
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
      index = parseRegistryIndex(text, this.#log)
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
