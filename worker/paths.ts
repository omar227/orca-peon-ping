import { homedir } from 'node:os'
import { join } from 'node:path'

export const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function packsRoot(home: string = homedir()): string {
  return join(home, '.openpeon', 'packs')
}

export function packDir(name: string, home: string = homedir()): string {
  if (!PACK_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid pack name: ${name}`)
  }
  return join(packsRoot(home), name)
}
