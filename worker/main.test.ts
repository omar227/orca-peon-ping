import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, mockHost, mountWorker, test } from 'orca/testing'
import type { PackListView } from '../src/protocol.ts'
import type { Installer, Registry } from './main.ts'
import * as main from './main.ts'
import type { Player } from './player.ts'
import type { RegistryIndex, RegistryPack } from './registry.ts'

let home: string
let played: { path: string; volume: number }[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'peon-main-'))
  played = []
  main.setDepOverrides({})
})

afterEach(async () => {
  main.setDepOverrides({})
  rmSync(home, { recursive: true, force: true })
})

function writePack(name: string, categories: Record<string, string[]>): void {
  const dir = join(home, '.openpeon', 'packs', name)
  mkdirSync(join(dir, 'sounds'), { recursive: true })
  const manifestCategories: Record<string, { sounds: { file: string }[] }> = {}
  for (const [category, files] of Object.entries(categories)) {
    for (const file of files) {
      writeFileSync(join(dir, 'sounds', file), `sound bytes for ${file}`)
    }
    manifestCategories[category] = { sounds: files.map((file) => ({ file })) }
  }
  writeFileSync(
    join(dir, 'openpeon.json'),
    JSON.stringify({
      cesp_version: '1.0',
      name,
      display_name: `${name} pack`,
      categories: manifestCategories
    })
  )
}

function spyPlayer(play?: (path: string, volume: number) => void): Player {
  return {
    kind: 'afplay',
    unavailableReason: null,
    play: (path, volume) => {
      played.push({ path, volume })
      play?.(path, volume)
    }
  }
}

function entry(name: string): RegistryPack {
  return {
    name,
    display_name: `${name} pack`,
    version: '1.0.0',
    trust_tier: 'official',
    categories: ['task.complete'],
    language: 'en',
    sound_count: 3,
    source_repo: 'PeonPing/og-packs',
    source_ref: 'v1.1.0',
    preview_sounds: ['preview.wav']
  }
}

const index: RegistryIndex = { version: 1, packs: [entry('peon'), entry('glados')] }

function stubRegistry(options?: { index?: RegistryIndex | null; error?: string }): Registry {
  return {
    load: async () => ({
      index: options?.index === undefined ? index : options.index,
      fetchedAt: 1,
      stale: false,
      error: options?.error ?? null
    })
  }
}

function stubInstaller(overrides?: Partial<Installer>): Installer {
  return {
    packDir: (name) => join(home, '.openpeon', 'packs', name),
    manifestPath: (name) => join(home, '.openpeon', 'packs', name, 'openpeon.json'),
    install: async () => {},
    adoptIfPresent: async () => false,
    remove: async () => {},
    status: async (pack) => ({
      name: pack.name,
      present: false,
      adopted: false,
      installedVersion: null,
      updateAvailable: false,
      removable: false
    }),
    downloadPreview: async () => join(home, 'preview.wav'),
    ...overrides
  }
}

/** Every test injects stubs so a test run never reaches the network or the real pack folder. */
function useStubs(overrides?: { installer?: Installer; registry?: Registry; player?: Player }) {
  main.setDepOverrides({
    home,
    player: overrides?.player ?? spyPlayer(),
    installer: overrides?.installer ?? stubInstaller(),
    registry: overrides?.registry ?? stubRegistry()
  })
}

test('the worker activates without refusals', async () => {
  useStubs()
  const worker = await mountWorker(main, { host: mockHost({ storage: { firstRunDone: true } }) })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a blocked agent event plays one sound', async () => {
  writePack('peon', { 'input.required': ['help.wav'] })
  useStubs()
  const worker = await mountWorker(main, {
    host: mockHost({
      storage: { activePack: 'peon', firstRunDone: true },
      settings: { muted: false }
    })
  })

  await worker.emit('agent.status.changed', {
    workspaceId: null,
    paneKey: 'tab-1:pane-1',
    title: 'Claude',
    state: 'blocked',
    receivedAt: Date.now()
  })

  assert.deepEqual(worker.refusals, [])
  assert.equal(played.length, 1)
  assert.ok(played[0].path.endsWith(join('sounds', 'help.wav')))
  await worker.deactivate()
})

test('the status bar item is updated on activation', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  useStubs()
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { activePack: 'peon', firstRunDone: true } })
  })

  const calls = worker.host.callsOf('statusBar.update') as { id: string; text?: string }[]
  assert.ok(calls.length >= 1)
  assert.equal(calls[0].id, 'active-pack')
  assert.match(String(calls[0].text), /peon pack/)
  await worker.deactivate()
})

test('first run installs the default pack once and latches on success', async () => {
  let installs = 0
  useStubs({
    installer: stubInstaller({
      install: async (pack) => {
        installs++
        writePack(pack.name, { 'task.complete': ['done.wav'] })
      }
    })
  })
  const host = mockHost({ storage: {} })

  const first = await mountWorker(main, { host })
  await first.request('packs.list', {})
  await first.deactivate()

  const second = await mountWorker(main, { host })
  await second.request('packs.list', {})
  await second.deactivate()

  assert.equal(installs, 1)
  assert.equal(host.data().storage.firstRunDone, true)
  assert.equal(host.data().storage.activePack, 'peon')
})

test('first run adopts a pack the peon-ping CLI already installed', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  let installs = 0
  useStubs({
    installer: stubInstaller({
      adoptIfPresent: async () => true,
      install: async () => {
        installs++
      }
    })
  })
  const host = mockHost({ storage: {} })

  const worker = await mountWorker(main, { host })
  const view = (await worker.request('packs.list', {})) as PackListView

  assert.equal(installs, 0)
  assert.equal(host.data().storage.activePack, 'peon')
  assert.equal(view.firstRunError, null)
  await worker.deactivate()
})

test('a failed first run does not latch and surfaces in the pack list', async () => {
  useStubs({
    installer: stubInstaller({
      install: async () => {
        throw new Error('the network is down')
      }
    })
  })
  const host = mockHost({ storage: {} })

  const worker = await mountWorker(main, { host })
  const view = (await worker.request('packs.list', {})) as PackListView

  assert.equal(host.data().storage.firstRunDone, undefined)
  assert.match(String(view.firstRunError), /the network is down/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('packs.preview plays even when muted and even inside the rate-limit floor', async () => {
  writePack('peon', { 'session.start': ['ready.wav'] })
  useStubs()
  const worker = await mountWorker(main, {
    host: mockHost({
      storage: { activePack: 'peon', firstRunDone: true },
      settings: { muted: true }
    })
  })

  await worker.request('packs.preview', { name: 'peon' })
  await worker.request('packs.preview', { name: 'peon' })

  assert.equal(played.length, 2)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('previewing a pack that is not installed downloads one of its preview sounds', async () => {
  const downloads: { pack: string; file: string }[] = []
  useStubs({
    installer: stubInstaller({
      downloadPreview: async (pack, file) => {
        downloads.push({ pack: pack.name, file })
        return join(home, 'preview.wav')
      }
    })
  })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { firstRunDone: true } })
  })

  await worker.request('packs.preview', { name: 'glados' })

  assert.deepEqual(downloads, [{ pack: 'glados', file: 'preview.wav' }])
  assert.equal(played.length, 1)
  await worker.deactivate()
})

test('packs.activate switches pack, updates the status bar and tells the panel', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  writePack('glados', { 'task.complete': ['done.wav'] })
  useStubs()
  const host = mockHost({ storage: { activePack: 'peon', firstRunDone: true } })
  const worker = await mountWorker(main, { host })
  const before = worker.host.callsOf('statusBar.update').length

  await worker.request('packs.activate', { name: 'glados' })

  assert.equal(host.data().storage.activePack, 'glados')
  assert.ok(worker.host.callsOf('statusBar.update').length > before)
  assert.ok(worker.posts.some((post) => post.event === 'packs.changed'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('packs.list reports the active pack, what it covers and the registry rows', async () => {
  writePack('peon', { 'task.complete': ['done.wav'], 'task.error': ['oops.wav'] })
  useStubs()
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { activePack: 'peon', firstRunDone: true } })
  })

  const view = (await worker.request('packs.list', {})) as PackListView

  assert.equal(view.activePack?.name, 'peon')
  assert.equal(view.activePack?.displayName, 'peon pack')
  assert.deepEqual(view.activePack?.covered.sort(), ['task.complete', 'task.error'])
  assert.deepEqual(
    view.rows.map((row) => row.name),
    ['peon', 'glados']
  )
  assert.equal(view.rows[0].active, true)
  assert.equal(view.error, null)
  assert.equal(view.playbackUnavailable, null)
  await worker.deactivate()
})

test('a player that throws is logged instead of taking the worker down', async () => {
  writePack('peon', { 'input.required': ['help.wav'] })
  useStubs({
    player: {
      kind: 'afplay',
      unavailableReason: null,
      play: () => {
        throw new Error('afplay exploded')
      }
    }
  })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { activePack: 'peon', firstRunDone: true } })
  })

  await worker.emit('agent.status.changed', {
    workspaceId: null,
    paneKey: 'tab-1:pane-1',
    title: 'Claude',
    state: 'blocked',
    receivedAt: Date.now()
  })

  assert.ok(worker.logs.some((line) => line.includes('afplay exploded')))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('packs.install installs a pack, starts playing it and tells the panel', async () => {
  useStubs({
    installer: stubInstaller({
      install: async (pack) => {
        writePack(pack.name, { 'task.complete': ['done.wav'] })
      }
    })
  })
  const host = mockHost({ storage: { firstRunDone: true } })
  const worker = await mountWorker(main, { host })

  await worker.request('packs.install', { name: 'glados' })

  assert.equal(host.data().storage.activePack, 'glados')
  assert.ok(worker.posts.some((post) => post.event === 'packs.changed'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('packs.remove deletes the pack and leaves nothing active', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  const removed: string[] = []
  useStubs({
    installer: stubInstaller({
      remove: async (name) => {
        removed.push(name)
      }
    })
  })
  const host = mockHost({ storage: { activePack: 'peon', firstRunDone: true } })
  const worker = await mountWorker(main, { host })

  await worker.request('packs.remove', { name: 'peon' })

  assert.deepEqual(removed, ['peon'])
  assert.equal(host.data().storage.activePack, null)
  await worker.deactivate()
})

test('a failed install reaches the panel and leaves no row busy', async () => {
  useStubs({
    installer: stubInstaller({
      install: async () => {
        throw new Error('the download failed')
      }
    })
  })
  const worker = await mountWorker(main, { host: mockHost({ storage: { firstRunDone: true } }) })

  await assert.rejects(worker.request('packs.install', { name: 'glados' }))

  const view = (await worker.request('packs.list', {})) as PackListView
  assert.equal(
    view.rows.every((row) => !row.busy),
    true
  )
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('an install after a failed first run retires the first-run error', async () => {
  let failing = true
  useStubs({
    installer: stubInstaller({
      install: async (pack) => {
        if (failing) throw new Error('the network is down')
        writePack(pack.name, { 'task.complete': ['done.wav'] })
      }
    })
  })
  const worker = await mountWorker(main, { host: mockHost({ storage: {} }) })

  const failed = (await worker.request('packs.list', {})) as PackListView
  assert.match(String(failed.firstRunError), /the network is down/)
  assert.equal(failed.activePack, null)

  failing = false
  await worker.request('packs.install', { name: 'peon' })

  const recovered = (await worker.request('packs.list', {})) as PackListView
  assert.equal(recovered.firstRunError, null)
  assert.equal(recovered.activePack?.name, 'peon')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
