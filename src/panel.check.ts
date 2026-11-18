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

/**
 * Real rows, copied from the live registry (`peonping.github.io/registry/index.json`) so the
 * screenshot in the README is the product rather than a fixture: the names, sound counts and
 * sizes are the ones a person actually sees.
 */
const peon = pack({
  name: 'peon',
  displayName: 'Orc Peon',
  description: 'Orc Peon sound pack from Warcraft III',
  trustTier: 'official',
  sizeBytes: 872_012,
  soundCount: 27,
  present: true,
  active: true,
  removable: true
})

const rows: PackRowView[] = [
  peon,
  pack({
    name: 'glados',
    displayName: 'GLaDOS (Portal)',
    description: 'GLaDOS (Portal) sound pack from Portal',
    trustTier: 'official',
    sizeBytes: 1_143_346,
    soundCount: 23,
    present: true,
    removable: true
  }),
  pack({
    name: 'duke_nukem',
    displayName: 'Duke Nukem',
    description: 'Duke Nukem sound pack from Duke Nukem',
    trustTier: 'official',
    sizeBytes: 7_737_086,
    soundCount: 24,
    busy: true,
    progressBytes: 18_350_080
  }),
  pack({
    name: 'protoss_probe',
    displayName: 'Protoss Probe (StarCraft)',
    description: 'Original StarCraft (1998) Protoss Probe unit sounds',
    trustTier: 'verified',
    sizeBytes: 1_044_060,
    soundCount: 16
  }),
  pack({
    name: 'solid_snake',
    displayName: 'Solid Snake',
    description:
      'Tactical espionage audio - featuring the legendary Solid Snake from the Metal Gear ' +
      'Solid series',
    sizeBytes: 1_067_760,
    soundCount: 32,
    present: true,
    adopted: true
  }),
  pack({
    name: 'itysl',
    displayName: 'I Think You Should Leave',
    description: 'Tim Robinson voice lines from I Think You Should Leave with Tim Robinson',
    sizeBytes: 2_070_304,
    soundCount: 24
  }),
  pack({
    name: 'speaki',
    displayName: 'Petite Speaki',
    description: 'Petite Speaki voice pack from Trickcal Chibi Go',
    sizeBytes: 1_104_000,
    soundCount: 13,
    canPreview: false
  })
]

const view = (over: Partial<PackListView> = {}): PackListView => ({
  rows,
  activePack: {
    name: 'peon',
    displayName: 'Orc Peon',
    covered: ['session.start', 'task.acknowledge', 'input.required', 'task.complete', 'task.error']
  },
  stale: false,
  error: null,
  playbackUnavailable: null,
  firstRunError: null,
  ...over
})

const uninstalled = rows.map((row) => ({
  ...row,
  progressBytes: null,
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
