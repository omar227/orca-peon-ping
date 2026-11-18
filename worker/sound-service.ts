import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CespSound,
  parseManifest,
  pickSound,
  resolveCategory,
  resolveSoundPath
} from './cesp.ts'
import type { SoundGate } from './gate.ts'
import { MANIFEST_FILE, verifySoundFile } from './install.ts'
import type { PlayableCategory } from './mapping.ts'
import { packDir } from './paths.ts'
import type { Player } from './player.ts'
import type { Store } from './store.ts'

export type Settings = {
  volume: number
  muted: boolean
  playSessionStart: boolean
  playTaskAcknowledge: boolean
  playInputRequired: boolean
  playTaskComplete: boolean
  playTaskError: boolean
  notifyWhenMuted: boolean
}

/** Mirrors `contributes.settings` in orca-plugin.json, for a host that answers without a key. */
export const DEFAULT_SETTINGS: Settings = {
  volume: 0.5,
  muted: false,
  playSessionStart: true,
  playTaskAcknowledge: true,
  playInputRequired: true,
  playTaskComplete: true,
  playTaskError: true,
  notifyWhenMuted: true
}

export const SETTING_FOR: Record<PlayableCategory, keyof Settings> = {
  'session.start': 'playSessionStart',
  'task.acknowledge': 'playTaskAcknowledge',
  'input.required': 'playInputRequired',
  'task.complete': 'playTaskComplete',
  'task.error': 'playTaskError'
}

/** The only categories worth a desktop toast: one per finished task across a fleet would be
 *  worse than the chime this plugin replaces. */
export const NOTIFY_CATEGORIES: readonly PlayableCategory[] = ['input.required', 'task.error']

const NOTIFICATION_TITLE = 'Peon Ping'

const WHAT_HAPPENED: Record<PlayableCategory, string> = {
  'session.start': 'started',
  'task.acknowledge': 'picked up work',
  'input.required': 'needs you',
  'task.complete': 'finished',
  'task.error': 'hit an error'
}

/** Turns the plugin's settings, whatever shape the host hands them back in, into `Settings`. */
export function toSettings(raw: Record<string, unknown> | null | undefined): Settings {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const flag = (key: keyof Settings): boolean => {
    const value = source[key]
    return typeof value === 'boolean' ? value : (DEFAULT_SETTINGS[key] as boolean)
  }
  return {
    volume:
      typeof source.volume === 'number' && Number.isFinite(source.volume)
        ? source.volume
        : DEFAULT_SETTINGS.volume,
    muted: flag('muted'),
    playSessionStart: flag('playSessionStart'),
    playTaskAcknowledge: flag('playTaskAcknowledge'),
    playInputRequired: flag('playInputRequired'),
    playTaskComplete: flag('playTaskComplete'),
    playTaskError: flag('playTaskError'),
    notifyWhenMuted: flag('notifyWhenMuted')
  }
}

export type SoundServiceDeps = {
  store: Store
  gate: SoundGate
  player: Player
  readSettings: () => Promise<Settings>
  notify: (title: string, body: string) => Promise<void>
  verifyFile?: typeof verifySoundFile
  home?: string
  log?: (message: string) => void
}

/**
 * Decides whether an event becomes a sound, a notification, or nothing at all.
 *
 * The order of the *checks* is fixed and stops at the first miss: the category's setting, mute,
 * an active pack, that pack's coverage of the category, a player that can play it, and then a
 * sound that survives verification. A miss at the setting is silent; a miss at mute, coverage or
 * playback support is worth telling the person about, for the two categories they would
 * otherwise wait on.
 *
 * The *gate* sits between the two: everything that decides whether a sound can be produced is
 * resolved first, then the gate is consumed, then the sound or its stand-in notification is
 * emitted. Two reasons. One, the design says the fallback notification "respects … both
 * rate-limit gates, so it can never be noisier than the sound would have been", and the muted
 * path used to return before the gate — a muted user with a fleet got one desktop toast per
 * blocked agent, during exactly the meeting mute exists for. Two, budget is better spent on
 * something that will really be emitted. Hashing candidate files stays *behind* the gate, so a
 * fleet cannot make the worker verify the same pack four times in half a second; a category
 * whose every sound fails verification therefore still consumes the gate, as it always did.
 */
export class SoundService {
  readonly #store: Store
  readonly #gate: SoundGate
  readonly #player: Player
  readonly #readSettings: () => Promise<Settings>
  readonly #notify: (title: string, body: string) => Promise<void>
  readonly #verifyFile: typeof verifySoundFile
  readonly #home: string | undefined
  readonly #log: (message: string) => void

  constructor(deps: SoundServiceDeps) {
    this.#store = deps.store
    this.#gate = deps.gate
    this.#player = deps.player
    this.#readSettings = deps.readSettings
    this.#notify = deps.notify
    this.#verifyFile = deps.verifyFile ?? verifySoundFile
    this.#home = deps.home
    this.#log = deps.log ?? (() => {})
  }

  async handle(category: PlayableCategory, agentTitle: string | undefined): Promise<void> {
    const settings = await this.#readSettings()

    // A category switched off is the one miss that is a deliberate choice, not a failure: it
    // neither plays, notifies, nor spends the gate.
    if (!settings[SETTING_FOR[category]]) return

    const playable = await this.#resolvePlayable(category, settings)

    if (!this.#gate.allow(category)) return
    if (playable === null) return this.#maybeNotify(category, agentTitle, settings)

    const chosen = await this.#firstVerified(playable.packName, category, playable.sounds)
    if (chosen === null) {
      this.#log(`no playable ${category} sound in pack ${playable.packName}`)
      return
    }

    this.#player.play(chosen.path, settings.volume)
    await this.#store.setLastPlayed(category, chosen.sound.file)
  }

  /**
   * The sounds that could play for this category, or null when none can — mute, no active pack,
   * a pack that does not cover it, or a platform with no player. All four are "a sound was
   * warranted and could not play", which is the one mechanism the fallback notification serves.
   */
  async #resolvePlayable(
    category: PlayableCategory,
    settings: Settings
  ): Promise<{ packName: string; sounds: CespSound[] } | null> {
    if (settings.muted) return null
    if (this.#player.unavailableReason !== null) return null

    const packName = await this.#store.getActivePack()
    if (packName === null) return null

    const sounds = this.#soundsFor(packName, category)
    if (sounds.length === 0) return null

    return { packName, sounds }
  }

  #packDir(packName: string): string {
    return packDir(packName, this.#home)
  }

  /** An unreadable or broken manifest counts as a pack that does not cover the category. */
  #soundsFor(packName: string, category: PlayableCategory): CespSound[] {
    try {
      const manifest = parseManifest(
        readFileSync(join(this.#packDir(packName), MANIFEST_FILE), 'utf8')
      )
      return resolveCategory(manifest, category)
    } catch (error) {
      this.#log(`could not read pack ${packName}: ${messageOf(error)}`)
      return []
    }
  }

  /** Tries candidates until one verifies, so a single corrupt file cannot silence a category. */
  async #firstVerified(
    packName: string,
    category: PlayableCategory,
    sounds: CespSound[]
  ): Promise<{ sound: CespSound; path: string } | null> {
    const lastFile = await this.#store.getLastPlayed(category)
    const remaining = [...sounds]

    while (remaining.length > 0) {
      const sound = pickSound(remaining, lastFile)
      if (sound === null) return null
      remaining.splice(remaining.indexOf(sound), 1)

      let path: string
      try {
        path = resolveSoundPath(this.#packDir(packName), sound.file)
      } catch (error) {
        this.#log(`skipping ${sound.file} in pack ${packName}: ${messageOf(error)}`)
        continue
      }
      if (await this.#verifyFile(path, sound.sha256 ?? null)) {
        return { sound, path }
      }
      this.#log(`skipping ${sound.file} in pack ${packName}: it does not match its hash`)
    }
    return null
  }

  async #maybeNotify(
    category: PlayableCategory,
    agentTitle: string | undefined,
    settings: Settings
  ): Promise<void> {
    if (!settings.notifyWhenMuted) return
    if (!NOTIFY_CATEGORIES.includes(category)) return
    const who = agentTitle ?? 'An agent'
    await this.#notify(NOTIFICATION_TITLE, `${who} ${WHAT_HAPPENED[category]}`)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
