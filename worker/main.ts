import { existsSync, readFileSync } from 'node:fs'
import type { Disposable, JsonValue, OrcaWorkerApi, PluginEvents } from 'orca/worker'
import type { PackListView, PackRowView } from '../src/protocol.ts'
import {
  type CespManifest,
  type CespSound,
  coveredCategories,
  parseManifest,
  pickSound,
  resolveCategory,
  resolveSoundPath
} from './cesp.ts'
import { SoundGate } from './gate.ts'
import { PackInstaller, type PackStatus } from './install.ts'
import { PaneTracker, type PlayableCategory } from './mapping.ts'
import { createPlayer, type Player, spawnDetached } from './player.ts'
import { RegistryClient, type RegistryPack } from './registry.ts'
import { DEFAULT_SETTINGS, type Settings, SoundService, toSettings } from './sound-service.ts'
import { Store, type StoreApi } from './store.ts'

const STATUS_BAR_ITEM_ID = 'active-pack'
const DEFAULT_PACK = 'peon'
/**
 * Orca's two payload caps, both from `workers/plugin-panel-bridge-protocol.js`:
 * `POST_MAX_BYTES = 256 * 1024` for one `orca.panels.post`, and `RESULT_MAX_BYTES = 1024 * 1024`
 * for one `plugin.request` answer. (256 KiB is also `PLUGIN_STORAGE_VALUE_MAX_BYTES` in
 * out/shared/plugins/workers/plugin-host-api-storage-schemas.js, which is why the registry cache
 * is a file.) Today's 382-pack registry measures ~129 KB as a push and ~181 KB as a `packs.list`
 * answer: half the push cap, and 5.8x inside the answer cap. Both grow with the registry, so the
 * push measures itself before posting rather than letting Orca reject it.
 */
export const POST_MAX_BYTES = 256 * 1024
export const RESULT_MAX_BYTES = 1024 * 1024

/**
 * How often a download may redraw the panel. Each push rebuilds and serialises the whole list,
 * so a per-chunk post would spend more time drawing rows than downloading the pack.
 */
const PROGRESS_POST_INTERVAL_MS = 1000
const PLAYABLE_CATEGORIES: readonly PlayableCategory[] = [
  'session.start',
  'task.acknowledge',
  'input.required',
  'task.complete',
  'task.error'
]

/** Only what this worker asks of a pack installer, so a test can stand one in. */
export type Installer = Pick<
  PackInstaller,
  | 'install'
  | 'adoptIfPresent'
  | 'remove'
  | 'status'
  | 'manifestPath'
  | 'packDir'
  | 'downloadPreview'
>
export type Registry = Pick<RegistryClient, 'load'> & { onRefreshed?: (() => void) | null }

export type WorkerDeps = {
  store: Store
  tracker: PaneTracker
  gate: SoundGate
  player: Player
  registry: Registry
  installer: Installer
  service: SoundService
  readSettings: () => Promise<Settings>
  home?: string
}
export type DepOverrides = Partial<WorkerDeps>

let depOverrides: DepOverrides = {}

/** Test seam: the next `activate` builds its dependencies with these overrides. */
export function setDepOverrides(overrides: DepOverrides): void {
  depOverrides = overrides
}

/** The plugin's private store, kept in Orca rather than on disk. */
function hostStoreApi(orca: OrcaWorkerApi): StoreApi {
  return {
    async get<T>(key: string): Promise<T | null> {
      const { value } = await orca.host.call('storage.get', { key })
      return (value ?? null) as T | null
    },
    async set(key: string, value: unknown): Promise<void> {
      await orca.host.call('storage.set', { key, value: (value ?? null) as JsonValue })
    }
  }
}

/** Settings Orca cannot answer for fall back to their defaults: silence is the worst outcome. */
async function readSettingsFrom(orca: OrcaWorkerApi): Promise<Settings> {
  try {
    const { settings } = await orca.host.call('settings.get')
    return toSettings(settings)
  } catch (error) {
    orca.log(`peon-ping: could not read settings, using defaults: ${messageOf(error)}`)
    return { ...DEFAULT_SETTINGS }
  }
}

export function createDeps(orca: OrcaWorkerApi, overrides: DepOverrides = {}): WorkerDeps {
  const home = overrides.home
  const store = overrides.store ?? new Store(hostStoreApi(orca))
  const gate = overrides.gate ?? new SoundGate()
  const player =
    overrides.player ??
    createPlayer(
      process.platform,
      spawnDetached((error) => orca.log(`peon-ping: could not start playback: ${error.message}`))
    )
  const readSettings = overrides.readSettings ?? (() => readSettingsFrom(orca))
  const service =
    overrides.service ??
    new SoundService({
      store,
      gate,
      player,
      readSettings,
      notify: async (title, body) => {
        try {
          await orca.host.call('notifications.show', { title, body })
        } catch (error) {
          orca.log(`peon-ping: could not show a notification: ${messageOf(error)}`)
        }
      },
      home,
      log: (message) => orca.log(`peon-ping: ${message}`)
    })

  return {
    store,
    tracker: overrides.tracker ?? new PaneTracker(),
    gate,
    player,
    registry:
      overrides.registry ??
      new RegistryClient({ home, log: (message) => orca.log(`peon-ping: ${message}`) }),
    installer: overrides.installer ?? new PackInstaller(store, { home }),
    service,
    readSettings,
    home
  }
}

/**
 * Everything the worker does: agent events become sounds, the panel's requests become pack
 * changes, and the status bar says which pack is playing. No path here may throw into Orca —
 * a worker that dies stops every sound.
 */
class PeonPing {
  readonly #orca: OrcaWorkerApi
  readonly #deps: WorkerDeps
  readonly #busy = new Set<string>()
  /** Bytes downloaded so far, per pack being installed, for the row's progress line. */
  readonly #progress = new Map<string, number>()
  #lastProgressPostAt = 0
  #firstRunError: string | null = null
  #ready: Promise<void> = Promise.resolve()

  constructor(orca: OrcaWorkerApi, deps: WorkerDeps) {
    this.#orca = orca
    this.#deps = deps
  }

  /** Subscribes, shows the status bar, and starts (without waiting for) the first-run install. */
  async start(): Promise<{ disposables: Disposable[]; ready: Promise<void> }> {
    const disposables: Disposable[] = [
      this.#orca.events.on('agent.status.changed', (payload) => this.#onAgentStatus(payload)),
      this.#orca.panels.handle('packs.list', (input) => this.#list(input?.force)),
      this.#orca.panels.handle('packs.install', (input) => this.#install(input.name)),
      this.#orca.panels.handle('packs.activate', (input) => this.#activatePack(input.name)),
      this.#orca.panels.handle('packs.remove', (input) => this.#remove(input.name)),
      this.#orca.panels.handle('packs.preview', (input) => this.#preview(input.name))
    ]
    // A registry refresh that lands behind the panel pushes the new list itself.
    this.#deps.registry.onRefreshed = () => {
      void this.#post()
    }
    await this.#updateStatusBar()
    this.#ready = this.#firstRun()
    return { disposables, ready: this.#ready }
  }

  async #onAgentStatus(payload: PluginEvents['agent.status.changed']): Promise<void> {
    try {
      const category = this.#deps.tracker.observe(payload)
      if (category === null) return
      await this.#deps.service.handle(category, payload.title)
    } catch (error) {
      this.#orca.log(`peon-ping: could not handle an agent status change: ${messageOf(error)}`)
    }
  }

  /**
   * Deliberately does not wait for `#ready`. The first-run install is a 56 MB download, and
   * `plugin.request` gives the panel 30 s by default: waiting here meant the first panel open on
   * a fresh machine — goal #4 of the design — timed out and rendered an error. What is available
   * now is answered now, and `packs.changed` delivers the pack when it lands.
   */
  async #list(force: boolean | undefined): Promise<PackListView> {
    return this.#buildView(force)
  }

  async #install(name: string): Promise<{ ok: true }> {
    const entry = await this.#entryFor(name)
    try {
      await this.#withBusy(name, () =>
        this.#deps.installer.install(entry, (downloaded) => this.#onProgress(name, downloaded))
      )
      // A pack nobody can hear is no use: the first one installed starts playing.
      if ((await this.#deps.store.getActivePack()) === null) {
        await this.#deps.store.setActivePack(name)
      }
    } finally {
      // Even a failed install has to clear the row's spinner in every open panel.
      await this.#changed()
    }
    return { ok: true }
  }

  async #activatePack(name: string): Promise<{ ok: true }> {
    if (this.#readManifest(name) === null) {
      throw new Error(`pack ${name} is not installed`)
    }
    await this.#deps.store.setActivePack(name)
    await this.#changed()
    return { ok: true }
  }

  async #remove(name: string): Promise<{ ok: true }> {
    try {
      await this.#withBusy(name, () => this.#deps.installer.remove(name))
      if ((await this.#deps.store.getActivePack()) === name) {
        await this.#deps.store.setActivePack(null)
      }
    } finally {
      await this.#changed()
    }
    return { ok: true }
  }

  /**
   * An explicit button press, so it skips mute and both rate-limit gates: if someone clicks
   * play, they want to hear it. An installed pack plays from disk; any other pack's preview
   * sound is fetched from its repository.
   */
  async #preview(name: string): Promise<{ ok: true }> {
    const unavailable = this.#deps.player.unavailableReason
    if (unavailable !== null) throw new Error(unavailable)

    const settings = await this.#deps.readSettings()
    this.#deps.player.play(await this.#previewPath(name), settings.volume)
    return { ok: true }
  }

  async #previewPath(name: string): Promise<string> {
    const manifest = this.#readManifest(name)
    const sound = manifest === null ? null : pickSound(previewSounds(manifest), null)
    if (sound !== null) {
      return resolveSoundPath(this.#deps.installer.packDir(name), sound.file)
    }

    const entry = await this.#entryFor(name)
    // `preview_sounds` is normalised by the registry parser, which also accepts the `{file}`
    // shape three live packs use; about 40 packs name none at all, and those rows offer no
    // Preview button, so this is the belt to that braces.
    const file = entry.preview_sounds?.[0]
    if (file === undefined) throw new Error(`pack ${name} has no sound to preview`)
    return this.#deps.installer.downloadPreview(entry, file)
  }

  // --- first run -------------------------------------------------------------------------

  /**
   * A fresh install should make a sound without being set up. A failure here (an offline
   * machine, say) is deliberately not latched, so the next worker start tries again.
   */
  async #firstRun(): Promise<void> {
    try {
      if (await this.#deps.store.isFirstRunDone()) return
      if ((await this.#deps.store.getActivePack()) !== null) return

      await this.#obtainDefaultPack()
      await this.#deps.store.setActivePack(DEFAULT_PACK)
      await this.#deps.store.markFirstRunDone()
      this.#firstRunError = null
      await this.#changed()
    } catch (error) {
      this.#firstRunError = messageOf(error)
      this.#orca.log(`peon-ping: could not set up the ${DEFAULT_PACK} pack: ${this.#firstRunError}`)
      // The panel no longer waits for this install, so the failure has to be pushed to it.
      await this.#post()
    }
  }

  async #obtainDefaultPack(): Promise<void> {
    // A pack the peon-ping CLI installed is taken as it is, never downloaded over.
    const adopted = await this.#deps.installer.adoptIfPresent(DEFAULT_PACK)
    if (adopted || this.#readManifest(DEFAULT_PACK) !== null) return

    const result = await this.#deps.registry.load()
    const entry = result.index?.packs.find((pack) => pack.name === DEFAULT_PACK)
    if (entry === undefined) {
      throw new Error(result.error ?? `the registry does not list a ${DEFAULT_PACK} pack`)
    }
    await this.#withBusy(DEFAULT_PACK, () =>
      this.#deps.installer.install(entry, (downloaded) =>
        this.#onProgress(DEFAULT_PACK, downloaded)
      )
    )
  }

  // --- views and side effects -------------------------------------------------------------

  async #buildView(force?: boolean): Promise<PackListView> {
    const result = await this.#deps.registry.load({ force })
    const installed = await this.#deps.store.getInstalled()
    const activeName = await this.#deps.store.getActivePack()

    // The first-run error describes a machine with no pack at all. Once one is active — whether
    // the retry, an install from the panel or an adoption put it there — the condition is gone,
    // and retiring the message here means no later path can leave it outliving its condition.
    if (activeName !== null) this.#firstRunError = null

    const rows: PackRowView[] = []
    for (const entry of result.index?.packs ?? []) {
      const status = await this.#statusOf(entry, installed[entry.name] !== undefined)
      rows.push({
        name: entry.name,
        displayName: entry.display_name ?? entry.name,
        description: entry.description ?? null,
        trustTier: entry.trust_tier,
        sizeBytes: entry.total_size_bytes ?? null,
        soundCount: entry.sound_count,
        present: status.present,
        active: entry.name === activeName,
        adopted: status.adopted,
        updateAvailable: status.updateAvailable,
        removable: status.removable,
        busy: this.#busy.has(entry.name),
        // An installed pack previews from its own manifest; anything else needs the registry to
        // name a file. Roughly one row in nine names none, and those offer no Preview.
        canPreview: status.present || (entry.preview_sounds?.length ?? 0) > 0,
        progressBytes: this.#progress.get(entry.name) ?? null
      })
    }

    // A pack the registry no longer lists, or that could not be fetched, is still on this
    // machine and still playable: the panel must be able to show and activate it.
    for (const [name, pack] of Object.entries(installed)) {
      if (rows.some((row) => row.name === name)) continue
      rows.push({
        name,
        displayName: this.#readManifest(name)?.display_name ?? name,
        description: null,
        trustTier: 'unlisted',
        sizeBytes: null,
        soundCount: 0,
        present: true,
        active: name === activeName,
        adopted: pack.adopted,
        updateAvailable: false,
        removable: !pack.adopted,
        busy: this.#busy.has(name),
        canPreview: true,
        progressBytes: this.#progress.get(name) ?? null
      })
    }

    return {
      rows,
      activePack: this.#activePackView(activeName),
      stale: result.stale,
      error: result.error,
      playbackUnavailable: this.#deps.player.unavailableReason,
      firstRunError: this.#firstRunError
    }
  }

  /**
   * The registry lists hundreds of packs; only the ones on this machine are worth a store read.
   * Tolerant of a row the registry parser somehow let through: a name `packDir` refuses, or a
   * store value from a future version, costs that row its install state and nothing more. One
   * row may never be able to fail the whole list again.
   */
  async #statusOf(entry: RegistryPack, recorded: boolean): Promise<PackStatus> {
    const absent: PackStatus = {
      name: entry.name,
      present: false,
      adopted: false,
      installedVersion: null,
      updateAvailable: false,
      removable: false
    }
    try {
      if (recorded || existsSync(this.#deps.installer.packDir(entry.name))) {
        return await this.#deps.installer.status(entry)
      }
    } catch (error) {
      this.#orca.log(`peon-ping: ignoring the pack entry ${entry.name}: ${messageOf(error)}`)
    }
    return absent
  }

  #activePackView(activeName: string | null): PackListView['activePack'] {
    if (activeName === null) return null
    const manifest = this.#readManifest(activeName)
    if (manifest === null) return { name: activeName, displayName: activeName, covered: [] }
    return {
      name: activeName,
      displayName: manifest.display_name ?? activeName,
      covered: coveredCategories(manifest, PLAYABLE_CATEGORIES)
    }
  }

  #readManifest(name: string): CespManifest | null {
    try {
      return parseManifest(readFileSync(this.#deps.installer.manifestPath(name), 'utf8'))
    } catch {
      return null
    }
  }

  async #entryFor(name: string): Promise<RegistryPack> {
    const result = await this.#deps.registry.load()
    const entry = result.index?.packs.find((pack) => pack.name === name)
    if (entry === undefined) {
      throw new Error(result.error ?? `the registry does not list a ${name} pack`)
    }
    return entry
  }

  async #withBusy<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.#busy.add(name)
    await this.#post()
    try {
      return await run()
    } finally {
      this.#busy.delete(name)
      this.#progress.delete(name)
    }
  }

  /**
   * The byte counter the download cap already keeps, shown on the row being installed — the
   * design asked for it and `busy` alone left a 56 MB first install looking like a hung spinner.
   * Throttled, because each push rebuilds and serialises the whole list.
   */
  #onProgress(name: string, downloaded: number): void {
    this.#progress.set(name, downloaded)
    const now = Date.now()
    if (now - this.#lastProgressPostAt < PROGRESS_POST_INTERVAL_MS) return
    this.#lastProgressPostAt = now
    void this.#post()
  }

  async #changed(): Promise<void> {
    await this.#updateStatusBar()
    await this.#post()
  }

  /**
   * Fire-and-forget, and deliberately unable to fail the mutation that triggered it. A payload
   * over Orca's push limit is not attempted at all: Orca would reject it, and that rejection
   * would surface as the install or activation failing. Skipping leaves the panel one explicit
   * `packs.list` behind, which it asks for after every action it takes anyway.
   */
  async #post(): Promise<void> {
    try {
      const view = await this.#buildView()
      const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
      if (bytes > POST_MAX_BYTES) {
        this.#orca.log(
          `peon-ping: the pack list is ${bytes} bytes, past the ${POST_MAX_BYTES}-byte push ` +
            'limit, so the panel keeps what it last asked for'
        )
        return
      }
      this.#orca.panels.post('packs.changed', view)
    } catch (error) {
      this.#orca.log(`peon-ping: could not tell the panel what changed: ${messageOf(error)}`)
    }
  }

  async #updateStatusBar(): Promise<void> {
    try {
      const active = this.#activePackView(await this.#deps.store.getActivePack())
      await this.#orca.host.call('statusBar.update', {
        id: STATUS_BAR_ITEM_ID,
        text: active?.displayName ?? 'Peon Ping',
        icon: 'bell',
        tooltip:
          active === null
            ? 'Peon Ping — no sound pack yet'
            : `Peon Ping — playing ${active.displayName}`,
        visible: true
      })
    } catch (error) {
      this.#orca.log(`peon-ping: could not update the status bar: ${messageOf(error)}`)
    }
  }
}

/** The categories a preview may come from, best first. */
function previewSounds(manifest: CespManifest): CespSound[] {
  for (const category of PLAYABLE_CATEGORIES) {
    const sounds = resolveCategory(manifest, category)
    if (sounds.length > 0) return sounds
  }
  return []
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let subscriptions: Disposable[] = []
let pending: Promise<unknown> = Promise.resolve()

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const { disposables, ready } = await new PeonPing(orca, createDeps(orca, depOverrides)).start()
  subscriptions = disposables
  pending = ready
  orca.log('peon-ping worker started')
}

export async function deactivate(): Promise<void> {
  for (const subscription of subscriptions.splice(0)) {
    try {
      subscription.dispose()
    } catch {
      // Orca drops the handlers anyway; nothing here may stop the worker from shutting down.
    }
  }
  await pending.catch(() => {})
}
