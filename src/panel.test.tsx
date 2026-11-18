import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'
import type { PackListView, PackRowView } from './protocol.ts'

const peonRow = (over: Partial<PackRowView> = {}): PackRowView => ({
  name: 'peon',
  displayName: 'Warcraft Peon',
  description: 'Work work.',
  trustTier: 'official',
  sizeBytes: 2_100_000,
  soundCount: 24,
  present: true,
  active: true,
  adopted: false,
  updateAvailable: false,
  removable: true,
  busy: false,
  canPreview: true,
  progressBytes: null,
  ...over
})

const gladosRow = (over: Partial<PackRowView> = {}): PackRowView =>
  peonRow({
    name: 'glados',
    displayName: 'GLaDOS',
    description: 'Aperture Science.',
    trustTier: 'verified',
    sizeBytes: 900_000,
    soundCount: 12,
    present: false,
    active: false,
    removable: false,
    ...over
  })

const view = (over: Partial<PackListView> = {}): PackListView => ({
  rows: [peonRow(), gladosRow()],
  activePack: {
    name: 'peon',
    displayName: 'Warcraft Peon',
    covered: ['task.complete', 'input.required']
  },
  stale: false,
  error: null,
  playbackUnavailable: null,
  firstRunError: null,
  ...over
})

test('the active pack and its covered categories are shown', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view() } }) })

  assert.ok(v.find({ text: /Warcraft Peon/ }))
  assert.ok(v.find({ text: /Finished/ }))
  assert.ok(v.find({ text: /Needs you/ }))
  assert.deepEqual(v.errors, [])
  assert.deepEqual(v.refusals, [])
  await v.unmount()
})

test('a pack that covers nothing playable says so', async () => {
  const covered: PackListView['activePack'] = {
    name: 'peon',
    displayName: 'Warcraft Peon',
    covered: []
  }
  const v = await mount(panel, {
    host: mockHost({ requests: { 'packs.list': () => view({ activePack: covered }) } })
  })

  assert.ok(v.find({ text: /covers none of the events/ }))
  await v.unmount()
})

test('no active pack is an empty state, not a blank card', async () => {
  const v = await mount(panel, {
    host: mockHost({ requests: { 'packs.list': () => view({ activePack: null }) } })
  })

  assert.ok(v.find({ type: 'EmptyState' }))
  await v.unmount()
})

test('typing in the search box filters the rows', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view() } }) })

  await v.type({ label: 'Search packs' }, 'glados')

  assert.equal(v.findAll({ type: 'ListItem' }).length, 1)
  assert.ok(v.find({ text: /GLaDOS/ }))
  await v.unmount()
})

test('the trust-tier filter narrows the list', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view() } }) })

  await v.select({ label: 'Filter packs' }, 'installed')

  assert.equal(v.findAll({ type: 'ListItem' }).length, 1)
  assert.ok(v.find({ text: /Warcraft Peon/ }))
  await v.unmount()
})

test('the list is capped, and says how many packs it is not showing', async () => {
  const rows = Array.from({ length: 382 }, (_, index) =>
    gladosRow({ name: `pack-${index}`, displayName: `Pack ${index}` })
  )
  const v = await mount(panel, {
    host: mockHost({ requests: { 'packs.list': () => view({ rows }) } })
  })

  assert.equal(v.findAll({ type: 'ListItem' }).length, 60)
  assert.ok(v.find({ text: /Showing 60 of 382/ }))
  await v.unmount()
})

test('Install calls packs.install and refreshes', async () => {
  const calls: string[] = []
  let lists = 0
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'packs.list': () => {
          lists += 1
          return view()
        },
        'packs.install': ({ name }) => {
          calls.push(name)
          return { ok: true } as const
        }
      }
    })
  })

  await v.press({ label: 'Install GLaDOS' })

  assert.deepEqual(calls, ['glados'])
  assert.equal(lists, 2)
  assert.deepEqual(v.refusals, [])
  await v.unmount()
})

test('Preview, Use, Update and Delete each reach the worker', async () => {
  const calls: string[] = []
  const record =
    (request: string) =>
    ({ name }: { name: string }) => {
      calls.push(`${request}:${name}`)
      return { ok: true } as const
    }
  const rows = [
    peonRow({ active: false, updateAvailable: true }),
    peonRow({ name: 'other', displayName: 'Other', present: true, active: true })
  ]
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'packs.list': () => view({ rows }),
        'packs.preview': record('preview'),
        'packs.activate': record('activate'),
        'packs.install': record('install'),
        'packs.remove': record('remove')
      }
    })
  })

  await v.press({ label: 'Preview Warcraft Peon' })
  await v.press({ label: 'Use Warcraft Peon' })
  await v.press({ label: 'Update Warcraft Peon' })
  await v.press({ label: 'Delete Warcraft Peon' })

  assert.deepEqual(calls, ['preview:peon', 'activate:peon', 'install:peon', 'remove:peon'])
  assert.deepEqual(v.refusals, [])
  await v.unmount()
})

test('an adopted pack offers no Delete', async () => {
  const adoptedRow = peonRow({ adopted: true, removable: false })
  const v = await mount(panel, {
    host: mockHost({ requests: { 'packs.list': () => view({ rows: [adoptedRow] }) } })
  })

  assert.equal(v.find({ label: /Delete/ }), null)
  await v.unmount()
})

test('a stale registry shows a warning and keeps the list usable', async () => {
  const v = await mount(panel, {
    host: mockHost({ requests: { 'packs.list': () => view({ stale: true, error: 'offline' }) } })
  })

  assert.ok(v.find({ type: 'Callout' }))
  assert.ok(v.findAll({ type: 'ListItem' }).length > 0)
  await v.unmount()
})

test('an unavailable player is stated plainly', async () => {
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'packs.list': () =>
          view({ playbackUnavailable: 'Audio playback is macOS-only in this version.' })
      }
    })
  })

  assert.ok(v.find({ text: /macOS-only/ }))
  assert.equal(v.find({ label: 'Preview GLaDOS' })?.disabled, true)
  await v.unmount()
})

test('a first-run failure offers Retry', async () => {
  const calls: string[] = []
  // As the worker does: the error describes a machine with no pack, and is retired once one is
  // installed and active.
  let firstRunError: string | null = 'offline'
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'packs.list': () => view({ firstRunError }),
        'packs.install': ({ name }) => {
          calls.push(name)
          firstRunError = null
          return { ok: true } as const
        }
      }
    })
  })

  assert.ok(v.find({ text: /Retry/ }))

  await v.press({ text: 'Retry' })

  assert.deepEqual(calls, ['peon'])
  assert.equal(v.find({ text: 'Retry' }), null)
  await v.unmount()
})

test('a request that fails is reported without losing the list', async () => {
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'packs.list': () => view(),
        'packs.preview': () => {
          throw new Error('Audio playback is macOS-only in this version.')
        }
      }
    })
  })

  await v.press({ label: 'Preview GLaDOS' })

  assert.ok(v.find({ text: /macOS-only/ }))
  assert.ok(v.findAll({ type: 'ListItem' }).length > 0)
  assert.deepEqual(v.errors, [])
  await v.unmount()
})

test('a pack the worker is working on shows a spinner instead of its actions', async () => {
  const v = await mount(panel, {
    host: mockHost({
      requests: { 'packs.list': () => view({ rows: [gladosRow({ busy: true })] }) }
    })
  })

  assert.ok(v.find({ type: 'Spinner' }))
  assert.equal(v.find({ label: 'Install GLaDOS' }), null)
  await v.unmount()
})

test('what the worker posts replaces the list', async () => {
  const v = await mount(panel, { host: mockHost({ requests: { 'packs.list': () => view() } }) })

  await v.post('packs.changed', view({ rows: [gladosRow({ present: true, active: true })] }))

  assert.equal(v.findAll({ type: 'ListItem' }).length, 1)
  assert.ok(v.find({ text: /GLaDOS/ }))
  await v.unmount()
})

test('a search says how many packs the catalogue holds, not just how many matched', async () => {
  const rows = [
    peonRow(),
    gladosRow(),
    ...Array.from({ length: 380 }, (_, index) =>
      gladosRow({ name: `pack-${index}`, displayName: `Pack ${index}` })
    )
  ]
  const v = await mount(panel, {
    host: mockHost({ requests: { 'packs.list': () => view({ rows }) } })
  })

  await v.type({ label: 'Search packs' }, 'GLaDOS')

  assert.ok(v.find({ text: /Showing 1 of 1 matches · 382 packs/ }))
  await v.unmount()
})

/**
 * `plugin.request` defaults to 30 s and an install is a download — 56 MB for the default pack.
 * The panel passed no override, so the first install on a fresh machine came back `timeout`
 * while the worker was still downloading. 120 s is Orca's maximum.
 */
test('an install is given the long timeout and an ordinary list is not', async () => {
  const v = await mount(panel, {
    host: mockHost({
      requests: { 'packs.list': () => view(), 'packs.install': () => ({ ok: true }) as const }
    })
  })

  await v.press({ label: 'Install GLaDOS' })

  const calls = v.host.callsOf('plugin.request') as {
    name: string
    timeoutMs?: number
  }[]
  const install = calls.find((call) => call.name === 'packs.install')
  const list = calls.find((call) => call.name === 'packs.list')
  assert.equal(install?.timeoutMs, 120_000)
  assert.equal(list?.timeoutMs, undefined)
  await v.unmount()
})

test('a row with nothing to preview offers no working Preview button', async () => {
  const v = await mount(panel, {
    host: mockHost({
      requests: { 'packs.list': () => view({ rows: [gladosRow({ canPreview: false })] }) }
    })
  })

  assert.equal(v.find({ label: 'Preview GLaDOS' })?.disabled, true)
  await v.unmount()
})

test('an installing row shows how much has been downloaded', async () => {
  const v = await mount(panel, {
    host: mockHost({
      requests: {
        'packs.list': () => view({ rows: [gladosRow({ busy: true, progressBytes: 12_582_912 })] })
      }
    })
  })

  assert.ok(v.find({ type: 'Spinner', label: /Downloading GLaDOS — 12\.0 MB/ }))
  await v.unmount()
})
