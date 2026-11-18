import { assert, test } from 'orca/testing'
import { REGISTRY_TTL_MS, RegistryClient } from './registry.ts'
import { Store } from './store.ts'
import { memoryStoreApi } from './testing/memory-store.ts'

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

test('a fresh cache is served without fetching', async () => {
  let fetches = 0
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 1000, index })
  const client = new RegistryClient(store, {
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

test('an expired cache triggers a fetch and is replaced', async () => {
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 0, index: { version: 1, packs: [] } })
  const client = new RegistryClient(store, {
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: ok(JSON.stringify(index)) as typeof fetch
  })
  assert.equal((await client.load()).index?.packs.length, 1)
})

// Review Focus 4
test('an HTML error page leaves the cached index intact', async () => {
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 0, index })
  const client = new RegistryClient(store, {
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: ok('<!DOCTYPE html><title>404</title>') as typeof fetch
  })
  const result = await client.load()
  assert.equal(result.index?.packs.length, 1)
  assert.equal(result.stale, true)
  assert.ok(result.error)
  assert.equal((await store.getRegistryCache())?.index.packs.length, 1)
})

test('a non-200 response leaves the cached index intact', async () => {
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 0, index })
  const client = new RegistryClient(store, {
    now: () => REGISTRY_TTL_MS + 1,
    fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch
  })
  const result = await client.load()
  assert.equal(result.index?.packs.length, 1)
  assert.ok(result.error)
})

test('a failed first fetch reports no index rather than throwing', async () => {
  const client = new RegistryClient(new Store(memoryStoreApi()), {
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
  const store = new Store(memoryStoreApi())
  await store.setRegistryCache({ fetchedAt: 1000, index: { version: 1, packs: [] } })
  const client = new RegistryClient(store, {
    now: () => 1000,
    fetchImpl: (async () => {
      fetches++
      return new Response(JSON.stringify(index))
    }) as typeof fetch
  })
  await client.load({ force: true })
  assert.equal(fetches, 1)
})
