import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, test } from 'orca/testing'
import { registryCachePath } from './paths.ts'
import {
  type RegistryCache,
  type RegistryCacheIo,
  REGISTRY_TTL_MS,
  RegistryClient,
  fileRegistryCache,
  parseRegistryIndex
} from './registry.ts'
import { syntheticIndex } from './testing/registry-fixture.ts'

/** Orca's own cap on one stored value, which is why this cache is a file and not storage. */
const PLUGIN_STORAGE_VALUE_MAX_BYTES = 256 * 1024

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'peon-registry-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const index = {
  version: 1,
  packs: [
    {
      name: 'peon',
      display_name: 'Peon',
      version: '1.0.0',
      trust_tier: 'official',
      categories: ['task.complete'],
      language: 'en',
      sound_count: 7,
      source_repo: 'PeonPing/og-packs',
      source_ref: 'v1.1.0'
    }
  ]
}
const ok = (body: string) => async () => new Response(body, { status: 200 })

function seedCache(value: RegistryCache): void {
  fileRegistryCache(home).write(value)
}

function readCacheFile(): RegistryCache {
  return JSON.parse(readFileSync(registryCachePath(home), 'utf8')) as RegistryCache
}

test('a fresh cache is served without fetching', async () => {
  let fetches = 0
  seedCache({ fetchedAt: 1000, index } as RegistryCache)
  const client = new RegistryClient({
    home,
    now: () => 1000 + REGISTRY_TTL_MS - 1,
    fetchImpl: (async () => {
      fetches++
      return new Response('{}')
    }) as typeof fetch
  })
  const result = await client.load()
  assert.equal(fetches, 0)
  assert.equal(result.index?.packs.length, 1)
  assert.equal(result.stale, false)
})

/**
 * The first open on a machine that has been away for a day must not wait on a 540 KB fetch:
 * `plugin.request` gives the panel 30 s by default and the whole thing rendered an error. The
 * out-of-date cache answers at once and the refresh lands behind it.
 */
test('an expired cache answers immediately and is replaced behind the panel', async () => {
  seedCache({ fetchedAt: 0, index: { version: 1, packs: [] } })
  const refreshes: number[] = []
  const client = new RegistryClient({
    home,
    now: () => REGISTRY_TTL_MS + 1,
    onRefreshed: () => refreshes.push(1),
    fetchImpl: ok(JSON.stringify(index)) as typeof fetch
  })

  const immediate = await client.load()
  assert.equal(immediate.index?.packs.length, 0)
  assert.equal(immediate.error, null)
  assert.equal(immediate.stale, false)

  await client.settled()
  assert.equal(refreshes.length, 1)
  assert.equal(readCacheFile().index.packs.length, 1)
  assert.equal((await client.load()).index?.packs.length, 1)
})

test('a refresh behind the panel runs once, however many loads ask for it', async () => {
  seedCache({ fetchedAt: 0, index: { version: 1, packs: [] } })
  let fetches = 0
  const client = new RegistryClient({
    home,
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: (async () => {
      fetches++
      return new Response(JSON.stringify(index))
    }) as typeof fetch
  })

  await Promise.all([client.load(), client.load(), client.load()])
  await client.settled()

  assert.equal(fetches, 1)
})

/**
 * A failed background refresh leaves the cache out of date, and every `packs.changed` push
 * calls `load()` again: without the cooldown the push and the refresh spin on each other for
 * as long as the registry is unreachable.
 */
test('a failed background refresh is not retried on every load', async () => {
  seedCache({ fetchedAt: 0, index } as RegistryCache)
  let fetches = 0
  const client = new RegistryClient({
    home,
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: (async () => {
      fetches++
      throw new Error('offline')
    }) as typeof fetch
  })

  await client.load()
  await client.settled()
  for (let i = 0; i < 5; i++) {
    await client.load()
    await client.settled()
  }

  assert.equal(fetches, 1)
  const after = await client.load()
  assert.equal(after.stale, true)
  assert.ok(after.error?.includes('offline'))
})

// Review Focus 4
test('an HTML error page leaves the cached index intact', async () => {
  seedCache({ fetchedAt: 0, index } as RegistryCache)
  const client = new RegistryClient({
    home,
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: ok('<!DOCTYPE html><title>404</title>') as typeof fetch
  })
  await client.load()
  await client.settled()

  const result = await client.load()
  assert.equal(result.index?.packs.length, 1)
  assert.equal(result.stale, true)
  assert.ok(result.error)
  assert.equal(readCacheFile().index.packs.length, 1)
})

test('a non-200 response leaves the cached index intact', async () => {
  seedCache({ fetchedAt: 0, index } as RegistryCache)
  const client = new RegistryClient({
    home,
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch
  })
  await client.load()
  await client.settled()

  const result = await client.load()
  assert.equal(result.index?.packs.length, 1)
  assert.ok(result.error)
})

test('a failed first fetch reports no index rather than throwing', async () => {
  const client = new RegistryClient({
    home,
    fetchImpl: (async () => {
      throw new Error('offline')
    }) as typeof fetch
  })
  const result = await client.load()
  assert.equal(result.index, null)
  assert.ok(result.error)
})

test('force refetches a cache that is still fresh', async () => {
  let fetches = 0
  seedCache({ fetchedAt: 1000, index: { version: 1, packs: [] } })
  const client = new RegistryClient({
    home,
    now: () => 1000,
    fetchImpl: (async () => {
      fetches++
      return new Response(JSON.stringify(index))
    }) as typeof fetch
  })
  await client.load({ force: true })
  assert.equal(fetches, 1)
})

/**
 * The bug every six-row fixture missed: the live registry is 382 packs and ~540 KB, which is
 * more than twice what one `storage.set` value may hold, so caching it in plugin storage threw
 * out of `load()` and took `packs.list` with it. 500 packs leaves headroom as the registry grows.
 */
test('a 500-pack registry loads, caches and reloads without throwing', async () => {
  const large = syntheticIndex(500)
  const body = JSON.stringify(large)
  assert.ok(
    body.length > PLUGIN_STORAGE_VALUE_MAX_BYTES * 2,
    `the fixture must be past the storage cap to be worth anything; it is ${body.length} bytes`
  )

  let fetches = 0
  const fetchImpl = (async () => {
    fetches++
    return new Response(body, { status: 200 })
  }) as typeof fetch

  const first = await new RegistryClient({ home, now: () => 10_000, fetchImpl }).load()
  assert.equal(first.error, null)
  assert.equal(first.index?.packs.length, 500)
  assert.equal(first.stale, false)
  assert.equal(first.index?.packs[499]?.name, 'synthetic-pack-0500')
  assert.equal(fetches, 1)

  // The whole index survived the round trip to disk, and the next load answers from it.
  assert.ok(readFileSync(registryCachePath(home), 'utf8').length > body.length)
  const second = await new RegistryClient({ home, now: () => 20_000, fetchImpl }).load()
  assert.equal(fetches, 1)
  assert.equal(second.index?.packs.length, 500)
  assert.equal(second.index?.packs[0]?.preview_sounds?.length, 3)

  // The atomic write cleans up after itself: no half-written temp file is left behind.
  const strays = readdirSync(join(home, '.openpeon')).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(strays, [])
})

/**
 * The invariant that was actually violated: a cache that cannot be written is a performance
 * problem, never a reason the panel shows nothing.
 */
test('a cache write that fails still returns the fetched index', async () => {
  const failing: RegistryCacheIo = {
    read: () => null,
    write: () => {
      throw new Error('disk is full')
    }
  }
  const logs: string[] = []
  const result = await new RegistryClient({
    home,
    cache: failing,
    log: (message) => logs.push(message),
    fetchImpl: ok(JSON.stringify(syntheticIndex(500))) as typeof fetch
  }).load()

  assert.equal(result.error, null)
  assert.equal(result.index?.packs.length, 500)
  assert.ok(logs.some((line) => line.includes('disk is full')))
})

test('a cache path that cannot be created still returns the fetched index', async () => {
  // A file where `~/.openpeon/` should be: every write against it fails, on a real filesystem.
  writeFileSync(join(home, '.openpeon'), 'not a directory')
  const logs: string[] = []
  const result = await new RegistryClient({
    home,
    log: (message) => logs.push(message),
    fetchImpl: ok(JSON.stringify(index)) as typeof fetch
  }).load()

  assert.equal(result.error, null)
  assert.equal(result.index?.packs.length, 1)
  assert.ok(logs.some((line) => line.includes('could not save the registry cache')))
})

test('a truncated cache file is treated as absent, not as an error', async () => {
  const full = JSON.stringify({ fetchedAt: 1000, index: syntheticIndex(500) })
  mkdirSync(join(home, '.openpeon'), { recursive: true })
  writeFileSync(registryCachePath(home), full.slice(0, Math.floor(full.length / 2)))

  const logs: string[] = []
  const result = await new RegistryClient({
    home,
    now: () => 1000,
    log: (message) => logs.push(message),
    fetchImpl: ok(JSON.stringify(index)) as typeof fetch
  }).load()

  // Absent, so it refetched despite the timestamp in the truncated file looking fresh.
  assert.equal(result.index?.packs.length, 1)
  assert.equal(result.error, null)
  assert.equal(result.stale, false)
  assert.ok(logs.some((line) => line.includes('unusable registry cache')))
  // And the good copy replaced it.
  assert.equal(readCacheFile().index.packs.length, 1)
})

test('a cache file of the wrong shape is treated as absent', async () => {
  mkdirSync(join(home, '.openpeon'), { recursive: true })
  for (const junk of ['null', '[]', '{}', '{"fetchedAt":1,"index":{"version":9,"packs":[]}}']) {
    writeFileSync(registryCachePath(home), junk)
    const result = await new RegistryClient({
      home,
      now: () => 1000,
      fetchImpl: ok(JSON.stringify(index)) as typeof fetch
    }).load()
    assert.equal(result.index?.packs.length, 1, `junk cache: ${junk}`)
    assert.equal(result.error, null, `junk cache: ${junk}`)
  }
})

test('a cache read that throws does not stop the load', async () => {
  const exploding: RegistryCacheIo = {
    read: () => {
      throw new Error('EIO')
    },
    write: () => {}
  }
  const result = await new RegistryClient({
    home,
    cache: exploding,
    fetchImpl: ok(JSON.stringify(index)) as typeof fetch
  }).load()
  assert.equal(result.index?.packs.length, 1)
  assert.equal(result.error, null)
})

test('an unreadable cache with an unreachable registry reports an error rather than throwing', async () => {
  mkdirSync(join(home, '.openpeon'), { recursive: true })
  writeFileSync(registryCachePath(home), '{ truncated')
  const result = await new RegistryClient({
    home,
    fetchImpl: (async () => {
      throw new Error('offline')
    }) as typeof fetch
  }).load()
  assert.equal(result.index, null)
  assert.equal(result.stale, false)
  assert.ok(result.error?.includes('offline'))
})

test('the cache file lands atomically, never as a partial write', () => {
  const cache = fileRegistryCache(home)
  cache.write({ fetchedAt: 1, index: syntheticIndex(500) })
  const first = readCacheFile()
  cache.write({ fetchedAt: 2, index: syntheticIndex(500) })
  const second = readCacheFile()

  assert.equal(first.index.packs.length, 500)
  assert.equal(second.fetchedAt, 2)
  assert.equal(second.index.packs.length, 500)
  assert.ok(existsSync(registryCachePath(home)))
  assert.deepEqual(
    readdirSync(join(home, '.openpeon')).filter((name) => name.endsWith('.tmp')),
    []
  )
})

/**
 * One row named `Bad.Name` used to reject `packs.list` outright — `packDir` refuses the name,
 * the throw escaped, and nobody could list, install or switch a pack until the registry was
 * fixed. A bad row may cost that row and nothing else.
 */
test('malformed registry rows are dropped, not thrown, and the good ones survive', () => {
  const logs: string[] = []
  const parsed = parseRegistryIndex(
    JSON.stringify({
      version: 1,
      packs: [
        { ...index.packs[0], name: 'Bad.Name' },
        { name: 'missing-fields' },
        { ...index.packs[0], name: 'no-sound-count', sound_count: 'twelve' },
        { ...index.packs[0], name: 'bad-repo', source_repo: 'not-a-repo' },
        'not even an object',
        null,
        index.packs[0]
      ]
    }),
    (message) => logs.push(message)
  )

  assert.deepEqual(
    parsed.packs.map((pack) => pack.name),
    ['peon']
  )
  assert.ok(logs.some((line) => line.includes('ignored 6 of 7')))
})

test('object-shaped preview_sounds are accepted and empty ones become absent', () => {
  const parsed = parseRegistryIndex(
    JSON.stringify({
      version: 1,
      packs: [
        { ...index.packs[0], name: 'itysl', preview_sounds: [{ file: 'a.wav', label: 'A' }] },
        { ...index.packs[0], name: 'nothing', preview_sounds: [] },
        { ...index.packs[0], name: 'absent' },
        { ...index.packs[0], name: 'junk', preview_sounds: [{ label: 'no file' }, 7] }
      ]
    })
  )

  const by = (name: string) => parsed.packs.find((pack) => pack.name === name)
  assert.deepEqual(by('itysl')?.preview_sounds, ['a.wav'])
  assert.equal(by('nothing')?.preview_sounds, undefined)
  assert.equal(by('absent')?.preview_sounds, undefined)
  assert.equal(by('junk')?.preview_sounds, undefined)
})

test('an index that is not an index still throws, so the cache is kept', () => {
  assert.throws(() => parseRegistryIndex('[]'))
  assert.throws(() => parseRegistryIndex('{"version":2,"packs":[]}'))
  assert.throws(() => parseRegistryIndex('<!DOCTYPE html>'))
})
