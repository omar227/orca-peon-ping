export type PackRowView = {
  name: string
  displayName: string
  description: string | null
  trustTier: string
  sizeBytes: number | null
  soundCount: number
  present: boolean
  active: boolean
  adopted: boolean
  updateAvailable: boolean
  removable: boolean
  busy: boolean
  /** Whether anything can be previewed: ~40 registry entries name no preview sound. */
  canPreview: boolean
  /** Bytes downloaded so far while this row is installing, else null. */
  progressBytes: number | null
}

export type PackListView = {
  rows: PackRowView[]
  activePack: { name: string; displayName: string; covered: string[] } | null
  /** The registry index is a cached copy the worker could not refresh. */
  stale: boolean
  /** Why the registry could not be read, if it could not. */
  error: string | null
  /** Why no sound can play on this machine, if none can. */
  playbackUnavailable: string | null
  /** Why the default pack could not be installed on first run, if it could not. */
  firstRunError: string | null
}

declare module 'orca' {
  interface PluginRequests {
    'packs.list': { input: { force?: boolean }; output: PackListView }
    'packs.install': { input: { name: string }; output: { ok: true } }
    'packs.activate': { input: { name: string }; output: { ok: true } }
    'packs.remove': { input: { name: string }; output: { ok: true } }
    'packs.preview': { input: { name: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    'packs.changed': PackListView
  }
}
