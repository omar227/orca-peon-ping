import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, mockHost, mountWorker, test } from 'orca/testing'
import type { PackListView } from '../src/protocol.ts'
import type { Installer, Registry } from './main.ts'
import * as main from './main.ts'
import type { Player } from './player.ts'
import type { RegistryIndex, RegistryPack } from './registry.ts'
import { syntheticIndex } from './testing/registry-fixture.ts'

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

/**
 * `packs.list` no longer waits for the first-run install (it is a 56 MB download and the panel's
 * request times out at 30 s), so a test that wants the first run's outcome waits for the push it
 * makes instead of assuming the request was behind it.
 */
async function untilPushed(worker: { posts: readonly { event: string }[] }): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (worker.posts.some((post) => post.event === 'packs.changed')) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('the worker never posted packs.changed')
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
  await untilPushed(worker)
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
  await untilPushed(worker)

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

/**
 * Six-row fixtures are what let a 256 KiB limit through twelve reviews: at the registry's real
 * size the pack list crossed Orca's per-value cap and `packs.list` failed outright. These two
 * drive the worker at 500 packs — past today's 382, with headroom as the registry grows.
 */
test('packs.list answers for a 500-pack registry', async () => {
  useStubs({ registry: stubRegistry({ index: syntheticIndex(500) }) })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { firstRunDone: true } })
  })

  const view = (await worker.request('packs.list', {})) as PackListView

  assert.equal(view.rows.length, 500)
  assert.equal(view.error, null)
  assert.equal(view.rows[499]?.name, 'synthetic-pack-0500')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a pack list past the push limit is skipped rather than failing the mutation', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  useStubs({ registry: stubRegistry({ index: syntheticIndex(500) }) })
  const host = mockHost({ storage: { activePack: 'glados', firstRunDone: true } })
  const worker = await mountWorker(main, { host })

  // 500 packs serialise to ~300 KB of `packs.changed`, over Orca's 256 KiB post cap.
  await worker.request('packs.activate', { name: 'peon' })

  assert.equal(host.data().storage.activePack, 'peon')
  assert.deepEqual(
    worker.posts.filter((post) => post.event === 'packs.changed'),
    []
  )
  assert.ok(worker.logs.some((line) => line.includes('push limit')))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a pack list under the push limit is still posted', async () => {
  writePack('peon', { 'task.complete': ['done.wav'] })
  useStubs({ registry: stubRegistry({ index: syntheticIndex(20) }) })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { activePack: 'glados', firstRunDone: true } })
  })

  await worker.request('packs.activate', { name: 'peon' })

  const posted = worker.posts.filter((post) => post.event === 'packs.changed')
  assert.ok(posted.length > 0)
  assert.equal((posted[posted.length - 1]?.payload as PackListView).rows.length, 20)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

/**
 * The first five minutes on a clean machine. `packs.list` used to await the whole first-run
 * install — 56 MB of archive — while `plugin.request` gives the panel 30 s, so the first panel
 * open on exactly the fresh-install path rendered a `timeout` error. If this test ever hangs,
 * that await is back.
 */
test('packs.list answers while the first-run install is still running', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  useStubs({
    installer: stubInstaller({
      install: async (pack) => {
        await held
        writePack(pack.name, { 'task.complete': ['done.wav'] })
      }
    })
  })
  const worker = await mountWorker(main, { host: mockHost({ storage: {} }) })

  const view = (await worker.request('packs.list', {})) as PackListView

  assert.deepEqual(
    view.rows.map((row) => row.name),
    ['peon', 'glados']
  )
  assert.equal(view.activePack, null)
  assert.equal(view.rows[0].busy, true)

  release()
  await worker.deactivate()
})

test('an installing row carries the bytes downloaded so far', async () => {
  useStubs({
    installer: stubInstaller({
      install: async (pack, onProgress) => {
        onProgress?.(1_000_000)
        // A real download is still running at this point; the push is fire-and-forget.
        await new Promise((resolve) => setTimeout(resolve, 20))
        writePack(pack.name, { 'task.complete': ['done.wav'] })
      }
    })
  })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { firstRunDone: true } })
  })

  await worker.request('packs.install', { name: 'glados' })

  const progressed = worker.posts
    .filter((post) => post.event === 'packs.changed')
    .flatMap((post) => (post.payload as PackListView).rows)
    .filter((row) => row.name === 'glados' && row.progressBytes !== null)
  assert.ok(progressed.length > 0)
  assert.equal(progressed[0].progressBytes, 1_000_000)

  // And it is cleared once the install is over.
  const view = (await worker.request('packs.list', {})) as PackListView
  assert.equal(view.rows.find((row) => row.name === 'glados')?.progressBytes, null)
  await worker.deactivate()
})

test('a registry refresh that lands behind the panel pushes the new list', async () => {
  let packs = [entry('peon')]
  useStubs({
    registry: {
      load: async () => ({ index: { version: 1, packs }, fetchedAt: 1, stale: false, error: null }),
      onRefreshed: null
    }
  })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { activePack: 'peon', firstRunDone: true } })
  })

  packs = [entry('peon'), entry('glados')]
  main.setDepOverrides({})
  await worker.request('packs.list', {})

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

/**
 * Orca's `plugin.request` answer cap is `RESULT_MAX_BYTES` (1 MiB) in
 * workers/plugin-panel-bridge-protocol.js. Today's 382-pack answer is ~181 KB; this drives it at
 * 500 packs so the headroom is measured rather than assumed.
 */
test('a 500-pack packs.list answer stays inside Orca answer cap', async () => {
  useStubs({ registry: stubRegistry({ index: syntheticIndex(500) }) })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { firstRunDone: true } })
  })

  const view = (await worker.request('packs.list', {})) as PackListView
  const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')

  assert.ok(bytes < main.RESULT_MAX_BYTES, `a 500-pack answer is ${bytes} bytes`)
  assert.ok(bytes > main.POST_MAX_BYTES, 'the fixture must be big enough to be worth anything')
  await worker.deactivate()
})

test('a row the registry names no preview sound for cannot be previewed', async () => {
  useStubs({
    registry: {
      load: async () => ({
        index: {
          version: 1,
          packs: [{ ...entry('peon'), preview_sounds: undefined }, entry('glados')]
        },
        fetchedAt: 1,
        stale: false,
        error: null
      })
    }
  })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { firstRunDone: true } })
  })

  const view = (await worker.request('packs.list', {})) as PackListView

  assert.equal(view.rows.find((row) => row.name === 'peon')?.canPreview, false)
  assert.equal(view.rows.find((row) => row.name === 'glados')?.canPreview, true)
  await assert.rejects(worker.request('packs.preview', { name: 'peon' }), /no sound to preview/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

/**
 * One row the registry parser could not have saved — a name `packDir` refuses — must cost that
 * row its install state and nothing else. It used to reject `packs.list` for every user.
 */
test('a pack entry whose name the filesystem refuses does not fail the whole list', async () => {
  useStubs({
    registry: {
      load: async () => ({
        index: { version: 1, packs: [{ ...entry('peon'), name: 'Bad.Name' }, entry('glados')] },
        fetchedAt: 1,
        stale: false,
        error: null
      })
    },
    installer: stubInstaller({
      packDir: (name) => {
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid pack name: ${name}`)
        return join(home, '.openpeon', 'packs', name)
      }
    })
  })
  const worker = await mountWorker(main, {
    host: mockHost({ storage: { firstRunDone: true } })
  })

  const view = (await worker.request('packs.list', {})) as PackListView

  assert.deepEqual(
    view.rows.map((row) => row.name),
    ['Bad.Name', 'glados']
  )
  assert.equal(view.rows[0].present, false)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
