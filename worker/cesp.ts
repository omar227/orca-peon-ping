import * as path from 'node:path'

export type CespSound = { file: string; label?: string; sha256?: string }

export type CespManifest = {
  cesp_version: string
  name: string
  display_name?: string
  version?: string
  description?: string
  license?: string
  categories?: Record<string, { sounds?: CespSound[] }>
  category_aliases?: Record<string, string>
}

export function parseManifest(text: string): CespManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('CESP manifest is not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('CESP manifest must be a JSON object')
  }

  const manifest = parsed as Partial<CespManifest>
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error('CESP manifest is missing a name')
  }
  if (typeof manifest.cesp_version !== 'string' || manifest.cesp_version.length === 0) {
    throw new Error('CESP manifest is missing a cesp_version')
  }

  return manifest as CespManifest
}

export function resolveCategory(manifest: CespManifest, category: string): CespSound[] {
  const direct = manifest.categories?.[category]
  if (direct) {
    return direct.sounds ?? []
  }

  const alias = manifest.category_aliases?.[category]
  if (alias !== undefined) {
    return manifest.categories?.[alias]?.sounds ?? []
  }

  return []
}

export function resolveSoundPath(packDir: string, file: string): string {
  if (path.isAbsolute(file)) {
    throw new Error(`CESP sound file must be a relative path: ${file}`)
  }

  const relative = file.includes('/') ? file : path.join('sounds', file)
  const resolvedPackDir = path.resolve(packDir)
  const resolved = path.resolve(resolvedPackDir, relative)

  if (resolved !== resolvedPackDir && !resolved.startsWith(resolvedPackDir + path.sep)) {
    throw new Error(`CESP sound file escapes the pack directory: ${file}`)
  }

  return resolved
}

export function pickSound(
  sounds: CespSound[],
  lastFile: string | null,
  random: () => number = Math.random
): CespSound | null {
  if (sounds.length === 0) {
    return null
  }

  const candidates =
    sounds.length > 1 && lastFile !== null ? sounds.filter((s) => s.file !== lastFile) : sounds

  const pool = candidates.length > 0 ? candidates : sounds
  const index = Math.floor(random() * pool.length)
  return pool[index]
}

export function coveredCategories(manifest: CespManifest, of: readonly string[]): string[] {
  return of.filter((category) => resolveCategory(manifest, category).length > 0)
}
