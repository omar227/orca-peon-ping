import { defineCheck } from 'orca/testing'
import type { PackListView, PackRowView } from './protocol.ts'

const pack = (over: Partial<PackRowView> & { name: string; displayName: string }): PackRowView => ({
  description: null,
  trustTier: 'community',
  sizeBytes: 1_400_000,
  soundCount: 12,
  present: false,
  active: false,
  adopted: false,
  updateAvailable: false,
  removable: false,
  busy: false,
  canPreview: true,
  progressBytes: null,
  ...over
})

const peon = pack({
  name: 'peon',
  displayName: 'Warcraft Peon',
  description: 'Work work. The namesake pack.',
  trustTier: 'official',
  sizeBytes: 2_100_000,
  soundCount: 24,
  present: true,
  active: true,
  removable: true
})

const rows: PackRowView[] = [
  peon,
  pack({
    name: 'glados',
    displayName: 'GLaDOS',
    description: 'Aperture Science Enrichment Center announcements.',
    trustTier: 'verified',
    soundCount: 18
  }),
  pack({
    name: 'sc2-adjutant',
    displayName: 'StarCraft II Adjutant and Terran Command Centre',
    description:
      'A long display name and a long description, to show how a narrow sidebar handles both.',
    trustTier: 'verified',
    sizeBytes: 5_600_000,
    soundCount: 31,
    present: true,
    updateAvailable: true,
    removable: true
  }),
  pack({
    name: 'tf2-engineer',
    displayName: 'TF2 Engineer',
    description: 'Adopted from the peon-ping CLI, so Peon Ping will not delete it.',
    sizeBytes: 3_200_000,
    present: true,
    adopted: true
  }),
  pack({
    name: 'duke-nukem',
    displayName: 'Duke Nukem',
    description: 'Installing now.',
    busy: true
  }),
  pack({ name: 'r2d2', displayName: 'R2-D2', description: 'Astromech beeps.', soundCount: 9 })
]

const view = (over: Partial<PackListView> = {}): PackListView => ({
  rows,
  activePack: {
    name: 'peon',
    displayName: 'Warcraft Peon',
    covered: ['session.start', 'input.required', 'task.complete', 'task.error']
  },
  stale: false,
  error: null,
  playbackUnavailable: null,
  firstRunError: null,
  ...over
})

const uninstalled = rows.map((row) => ({
  ...row,
  present: false,
  active: false,
  adopted: false,
  updateAvailable: false,
  removable: false,
  busy: false
}))

export default defineCheck({
  default: { requests: { 'packs.list': view() } },
  empty: { requests: { 'packs.list': view({ rows: uninstalled, activePack: null }) } },
  stale: {
    requests: {
      'packs.list': view({ stale: true, error: 'Could not reach the registry: fetch failed' })
    }
  },
  'unsupported-platform': {
    requests: {
      'packs.list': view({ playbackUnavailable: 'Audio playback is macOS-only in this version.' })
    }
  }
})
