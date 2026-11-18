import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, test } from 'orca/testing'
import type { verifySoundFile } from './install.ts'
import { SoundGate } from './gate.ts'
import { createPlayer, type Player } from './player.ts'
import { DEFAULT_SETTINGS, type Settings, SoundService, toSettings } from './sound-service.ts'
import { Store } from './store.ts'
import { memoryStoreApi } from './testing/memory-store.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'peon-sound-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

type PackSound = string | { file: string; sha256: string }

/** Writes a pack on disk the way an install leaves it: a manifest beside a `sounds/` folder. */
function writePack(name: string, categories: Record<string, PackSound[]>): void {
  const dir = join(home, '.openpeon', 'packs', name)
  mkdirSync(join(dir, 'sounds'), { recursive: true })
  const manifestCategories: Record<string, { sounds: { file: string; sha256?: string }[] }> = {}
  for (const [category, entries] of Object.entries(categories)) {
    const sounds = entries.map((entry) => (typeof entry === 'string' ? { file: entry } : entry))
    for (const sound of sounds) {
      writeFileSync(join(dir, 'sounds', sound.file), `sound bytes for ${sound.file}`)
    }
    manifestCategories[category] = { sounds }
  }
  writeFileSync(
    join(dir, 'openpeon.json'),
    JSON.stringify({
      cesp_version: '1.0',
      name,
      display_name: 'Orc Peon',
      categories: manifestCategories
    })
  )
}

type Harness = {
  service: SoundService
  store: Store
  played: { path: string; volume: number }[]
  notifications: { title: string; body: string }[]
}

function harness(options?: {
  settings?: Partial<Settings>
  player?: Player
  gate?: SoundGate
  verifyFile?: typeof verifySoundFile
}): Harness {
  const played: { path: string; volume: number }[] = []
  const notifications: { title: string; body: string }[] = []
  const store = new Store(memoryStoreApi())
  const spy: Player = {
    kind: 'afplay',
    unavailableReason: null,
    play: (path, volume) => {
      played.push({ path, volume })
    }
  }
  const service = new SoundService({
    store,
    gate: options?.gate ?? new SoundGate(),
    player: options?.player ?? spy,
    readSettings: async () => ({ ...DEFAULT_SETTINGS, ...options?.settings }),
    notify: async (title, body) => {
      notifications.push({ title, body })
    },
    verifyFile: options?.verifyFile,
    home
  })
  return { service, store, played, notifications }
}

test('a muted plugin notifies for input.required and stays quiet otherwise', async () => {
  writePack('peon', { 'input.required': ['help.wav'], 'task.acknowledge': ['work.wav'] })
  const { service, store, played, notifications } = harness({
    settings: { muted: true, notifyWhenMuted: true }
  })
  await store.setActivePack('peon')

  await service.handle('input.required', 'Claude')
  await service.handle('task.acknowledge', 'Claude')

  assert.equal(played.length, 0)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].title, 'Peon Ping')
  assert.match(notifications[0].body, /Claude/)
})

test('a muted plugin with notifications off stays completely quiet', async () => {
  writePack('peon', { 'input.required': ['help.wav'] })
  const { service, store, played, notifications } = harness({
    settings: { muted: true, notifyWhenMuted: false }
  })
  await store.setActivePack('peon')

  await service.handle('input.required', 'Claude')

  assert.equal(played.length, 0)
  assert.equal(notifications.length, 0)
})

test('a disabled category plays nothing and notifies nothing', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  const { service, store, played, notifications } = harness({
    settings: { playTaskComplete: false, muted: false }
  })
  await store.setActivePack('peon')

  await service.handle('task.complete', 'Claude')

  assert.equal(played.length, 0)
  assert.equal(notifications.length, 0)
})

test('a category the pack does not cover notifies when it is notify-worthy', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  const { service, store, played, notifications } = harness()
  await store.setActivePack('peon')

  await service.handle('task.error', 'Codex')

  assert.equal(played.length, 0)
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].body, /Codex/)
})

test('an unsupported platform notifies instead of playing', async () => {
  writePack('peon', { 'input.required': ['help.wav'] })
  const { service, store, played, notifications } = harness({ player: createPlayer('linux') })
  await store.setActivePack('peon')

  await service.handle('input.required', 'Claude')

  assert.equal(played.length, 0)
  assert.equal(notifications.length, 1)
})

test('playing records lastPlayed so the next pick differs', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  const { service, store, played } = harness()
  await store.setActivePack('peon')

  await service.handle('task.complete', 'Claude')

  assert.equal(played.length, 1)
  assert.ok(played[0].path.endsWith(join('sounds', 'done.wav')))
  assert.equal(await store.getLastPlayed('task.complete'), 'done.wav')
})

test('the volume setting reaches the player', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  const { service, store, played } = harness({ settings: { volume: 0.25 } })
  await store.setActivePack('peon')

  await service.handle('task.complete', 'Claude')

  assert.equal(played[0].volume, 0.25)
})

test('a gated sound neither plays nor notifies', async () => {
  writePack('peon', { 'input.required': ['help.wav'] })
  const gate = new SoundGate({ now: () => 0 })
  const { service, store, played, notifications } = harness({ gate })
  await store.setActivePack('peon')
  assert.equal(gate.allow('input.required'), true)

  await service.handle('input.required', 'Claude')

  assert.equal(played.length, 0)
  assert.equal(notifications.length, 0)
})

test('no active pack is silent and does not throw', async () => {
  const { service, played } = harness()

  await service.handle('task.complete', 'Claude')

  assert.equal(played.length, 0)
})

test('an active pack that is not on disk is silent and does not throw', async () => {
  const { service, store, played } = harness()
  await store.setActivePack('peon')

  await service.handle('task.complete', 'Claude')

  assert.equal(played.length, 0)
})

test('a sound whose hash does not match is skipped and another is tried', async () => {
  writePack('peon', { 'task.complete': ['one.wav', 'two.wav'] })
  const seen: string[] = []
  const { service, store, played } = harness({
    verifyFile: async (absolutePath) => {
      seen.push(absolutePath)
      return seen.length > 1
    }
  })
  await store.setActivePack('peon')

  await service.handle('task.complete', 'Claude')

  assert.equal(played.length, 1)
  assert.equal(seen.length, 2)
  assert.notEqual(played[0].path, seen[0])
})

test('a category whose every sound fails verification stays silent', async () => {
  writePack('peon', { 'task.complete': ['one.wav', 'two.wav'] })
  const { service, store, played } = harness({ verifyFile: async () => false })
  await store.setActivePack('peon')

  await service.handle('task.complete', 'Claude')

  assert.equal(played.length, 0)
})

test('a sound that plays is verified against the manifest hash', async () => {
  writePack('peon', { 'task.complete': [{ file: 'done.wav', sha256: 'abc123' }] })
  const asked: { path: string; sha: string | null }[] = []
  const { service, store, played } = harness({
    verifyFile: async (absolutePath, expectedSha256) => {
      asked.push({ path: absolutePath, sha: expectedSha256 })
      return true
    }
  })
  await store.setActivePack('peon')

  await service.handle('task.complete', 'Claude')

  assert.equal(played.length, 1)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].sha, 'abc123')
})

test('settings the host cannot answer for fall back to their declared defaults', () => {
  assert.deepEqual(toSettings({ muted: true, volume: 0.1 }), {
    ...DEFAULT_SETTINGS,
    muted: true,
    volume: 0.1
  })
  assert.deepEqual(toSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(toSettings({ volume: 'loud', muted: 'yes' }), DEFAULT_SETTINGS)
})
