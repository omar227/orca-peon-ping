import { homedir } from 'node:os'
import { join } from 'node:path'

export const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The directory this plugin shares with the peon-ping CLI. */
function openpeonRoot(home: string = homedir()): string {
  return join(home, '.openpeon')
}

export function packsRoot(home: string = homedir()): string {
  return join(openpeonRoot(home), 'packs')
}

/** The registry index cache. On disk rather than in plugin storage: see worker/registry.ts. */
export function registryCachePath(home: string = homedir()): string {
  return join(openpeonRoot(home), 'registry-cache.json')
}

export function packDir(name: string, home: string = homedir()): string {
  if (!PACK_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid pack name: ${name}`)
  }
  return join(packsRoot(home), name)
}
