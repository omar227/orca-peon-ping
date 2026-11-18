import { assert, test } from 'orca/testing'
import { Store } from './store.ts'
import { memoryStoreApi } from './testing/memory-store.ts'

test('the store round-trips the active pack', async () => {
  const store = new Store(memoryStoreApi())
  assert.equal(await store.getActivePack(), null)
  await store.setActivePack('peon')
  assert.equal(await store.getActivePack(), 'peon')
})

test('installed packs accumulate and can be forgotten', async () => {
  const store = new Store(memoryStoreApi())
  await store.recordInstalled({
    name: 'peon',
    version: '1.0.0',
    sourceRef: 'v1.1.0',
    manifestSha256: null,
    installedAt: 1,
    adopted: false
  })
  await store.recordInstalled({
    name: 'glados',
    version: '1.0.0',
    sourceRef: 'v1.1.0',
    manifestSha256: null,
    installedAt: 2,
    adopted: true
  })
  assert.deepEqual(Object.keys(await store.getInstalled()).sort(), ['glados', 'peon'])
  await store.forgetInstalled('peon')
  assert.deepEqual(Object.keys(await store.getInstalled()), ['glados'])
})

test('lastPlayed is tracked per category', async () => {
  const store = new Store(memoryStoreApi())
  await store.setLastPlayed('task.complete', 'a.wav')
  assert.equal(await store.getLastPlayed('task.complete'), 'a.wav')
  assert.equal(await store.getLastPlayed('task.error'), null)
})

test('firstRunDone starts false and latches', async () => {
  const store = new Store(memoryStoreApi())
  assert.equal(await store.isFirstRunDone(), false)
  await store.markFirstRunDone()
  assert.equal(await store.isFirstRunDone(), true)
})

test('a corrupted installedPacks value reads back as empty rather than throwing', async () => {
  const api = memoryStoreApi()
  await api.set('installedPacks', 'not an object')
  const store = new Store(api)
  assert.deepEqual(await store.getInstalled(), {})
  await store.recordInstalled({
    name: 'peon',
    version: '1.0.0',
    sourceRef: 'v1.0.0',
    manifestSha256: null,
    installedAt: 1,
    adopted: false
  })
  assert.deepEqual(Object.keys(await store.getInstalled()), ['peon'])
})

test('a corrupted lastPlayed value reads back as empty rather than throwing', async () => {
  const api = memoryStoreApi()
  await api.set('lastPlayed', 'not an object')
  const store = new Store(api)

  assert.equal(await store.getLastPlayed('task.complete'), null)
  await store.setLastPlayed('task.complete', 'done.wav')
  assert.equal(await store.getLastPlayed('task.complete'), 'done.wav')
})

test('a lastPlayed entry that is not a string reads back as absent', async () => {
  const api = memoryStoreApi()
  await api.set('lastPlayed', { 'task.complete': 42 })
  assert.equal(await new Store(api).getLastPlayed('task.complete'), null)
})
