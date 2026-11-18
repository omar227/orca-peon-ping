import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type CespManifest, parseManifest, resolveSoundPath } from './cesp.ts'
import { packDir, packsRoot } from './paths.ts'
import type { RegistryPack } from './registry.ts'
import type { InstalledPack, Store } from './store.ts'

export const MANIFEST_FILE = 'openpeon.json'

export type PackStatus = {
  name: string
  present: boolean
  adopted: boolean
  installedVersion: string | null
  updateAvailable: boolean
  removable: boolean
}

/**
 * Resolves one tar entry against the directory it is being extracted into, refusing anything
 * that would land outside it. Lexical only — the extracted tree is separately walked with
 * `lstat` so a symlinked entry cannot widen the destination afterwards.
 */
export function tarEntryTarget(destDir: string, entryPath: string): string {
  if (entryPath.length === 0) {
    throw new Error('tar entry has an empty path')
  }
  if (isAbsolute(entryPath) || entryPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entryPath)) {
    throw new Error(`tar entry has an absolute path: ${entryPath}`)
  }

  const dest = resolve(destDir)
  const target = resolve(dest, entryPath)
  if (target !== dest && !target.startsWith(dest + sep)) {
    throw new Error(`tar entry escapes the destination: ${entryPath}`)
  }
  return target
}

export async function verifySoundFile(
  absolutePath: string,
  expectedSha256: string | null
): Promise<boolean> {
  let bytes: Buffer
  try {
    bytes = readFileSync(absolutePath)
  } catch {
    return false
  }
  if (expectedSha256 === null) {
    return true
  }
  return sha256(bytes) === expectedSha256.toLowerCase()
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function runTar(args: readonly string[]): Promise<string> {
  return new Promise((fulfil, reject) => {
    const child = spawn('tar', [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) => reject(new Error(`could not run tar: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        fulfil(stdout)
      } else {
        reject(new Error(`tar exited with ${code}: ${stderr.trim()}`))
      }
    })
  })
}

/** The single top-level directory GitHub wraps a tag archive in, e.g. `og-packs-1.1.0`. */
function archiveRootOf(entryPaths: readonly string[]): string {
  const first = entryPaths[0]
  if (first === undefined) {
    throw new Error('pack archive is empty')
  }
  const root = first.split('/')[0]
  if (root.length === 0) {
    throw new Error(`pack archive has no top-level directory: ${first}`)
  }
  return root
}

function sourcePathOf(entry: RegistryPack): string {
  const raw = entry.source_path ?? entry.name
  const trimmed = raw.replace(/^\/+|\/+$/g, '')
  if (trimmed.length === 0) {
    throw new Error(`registry entry ${entry.name} has an empty source_path`)
  }
  return trimmed
}

/**
 * Refuses any extracted entry that is not a plain file or directory. A symlink would let a pack
 * point the player at files outside the pack, which `resolveSoundPath`'s lexical check cannot see.
 */
function assertPlainTree(dir: string, root: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stats = lstatSync(full)
    const shown = relative(root, full)
    if (stats.isSymbolicLink()) {
      throw new Error(`pack entry is a symbolic link: ${shown}`)
    }
    if (stats.isDirectory()) {
      assertPlainTree(full, root)
      continue
    }
    if (!stats.isFile()) {
      throw new Error(`pack entry is not a regular file: ${shown}`)
    }
    if (stats.nlink > 1) {
      throw new Error(`pack entry is a hard link: ${shown}`)
    }
  }
}

export class PackInstaller {
  readonly #store: Store
  readonly #home: string | undefined
  readonly #fetchImpl: typeof fetch
  readonly #now: () => number

  constructor(
    store: Store,
    options?: { home?: string; fetchImpl?: typeof fetch; now?: () => number }
  ) {
    this.#store = store
    this.#home = options?.home
    this.#fetchImpl = options?.fetchImpl ?? fetch
    this.#now = options?.now ?? Date.now
  }

  packDir(name: string): string {
    return packDir(name, this.#home)
  }

  manifestPath(name: string): string {
    return join(this.packDir(name), MANIFEST_FILE)
  }

  /**
   * Downloads and unpacks a registry entry. Everything happens in a staging directory beside the
   * destination and is only swapped into place once the whole tree has been validated, so a
   * failure at any point leaves the destination exactly as it was.
   */
  async install(entry: RegistryPack): Promise<void> {
    const dest = this.packDir(entry.name)
    if ((await this.#store.getInstalled())[entry.name]?.adopted === true) {
      throw new Error(
        `pack ${entry.name} was adopted from another tool and will not be overwritten`
      )
    }

    const root = packsRoot(this.#home)
    mkdirSync(root, { recursive: true })

    const staging = mkdtempSync(join(root, '.install-'))
    try {
      const tarball = join(staging, 'pack.tar.gz')
      writeFileSync(tarball, await this.#downloadTarball(entry))

      const extracted = join(staging, 'extract')
      mkdirSync(extracted)
      await this.#extractPack(entry, tarball, extracted)
      assertPlainTree(extracted, extracted)

      const manifestFile = join(extracted, MANIFEST_FILE)
      if (!existsSync(manifestFile)) {
        throw new Error(`pack ${entry.name} has no ${MANIFEST_FILE}`)
      }
      // The registry index is not field-validated, so treat anything but a string as absent
      // rather than failing a good pack on its one optional integrity field.
      const expectedSha = typeof entry.manifest_sha256 === 'string' ? entry.manifest_sha256 : null
      const manifestBytes = readFileSync(manifestFile)
      if (expectedSha !== null) {
        const actual = sha256(manifestBytes)
        if (actual !== expectedSha.toLowerCase()) {
          throw new Error(`pack ${entry.name} manifest sha256 is ${actual}, expected ${expectedSha}`)
        }
      }
      parseManifest(manifestBytes.toString('utf8'))

      swapIntoPlace(extracted, dest, join(staging, 'previous'))
      await this.#record(entry.name, {
        version: entry.version,
        sourceRef: entry.source_ref,
        manifestSha256: expectedSha,
        adopted: false
      })
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  async #downloadTarball(entry: RegistryPack): Promise<Buffer> {
    const url = `https://github.com/${entry.source_repo}/archive/refs/tags/${entry.source_ref}.tar.gz`
    const response = await this.#fetchImpl(url)
    if (!response.ok) {
      throw new Error(`pack download failed with ${response.status}: ${url}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  /** Extracts just the pack's subtree, with every entry path checked before tar writes it. */
  async #extractPack(entry: RegistryPack, tarball: string, into: string): Promise<void> {
    const listing = await runTar(['-tzf', tarball])
    const entryPaths = listing.split('\n').filter((line) => line.length > 0)
    for (const entryPath of entryPaths) {
      tarEntryTarget(into, entryPath)
    }

    const member = `${archiveRootOf(entryPaths)}/${sourcePathOf(entry)}`
    tarEntryTarget(into, member)
    const depth = member.split('/').length
    await runTar(['-xzf', tarball, '-C', into, '--strip-components', String(depth), member])
  }

  /**
   * Records a pack directory this plugin did not create — peon-ping shares `~/.openpeon/packs`,
   * so an existing pack is taken as-is and never overwritten or deleted.
   */
  async adoptIfPresent(name: string): Promise<boolean> {
    if ((await this.#store.getInstalled())[name] !== undefined) {
      return false
    }

    let manifest: CespManifest
    try {
      manifest = parseManifest(readFileSync(this.manifestPath(name), 'utf8'))
    } catch {
      return false
    }

    await this.#record(name, {
      version: manifest.version ?? null,
      sourceRef: null,
      manifestSha256: null,
      adopted: true
    })
    return true
  }

  async remove(name: string): Promise<void> {
    const recorded = (await this.#store.getInstalled())[name]
    if (recorded === undefined) {
      throw new Error(`pack ${name} is not installed by this plugin`)
    }
    if (recorded.adopted) {
      throw new Error(`pack ${name} was adopted from another tool and will not be deleted`)
    }
    rmSync(this.packDir(name), { recursive: true, force: true })
    await this.#store.forgetInstalled(name)
  }

  async status(entry: RegistryPack): Promise<PackStatus> {
    const recorded = (await this.#store.getInstalled())[entry.name]
    const present = existsSync(this.packDir(entry.name))
    const adopted = recorded?.adopted ?? false
    const installedVersion = recorded?.version ?? null
    return {
      name: entry.name,
      present,
      adopted,
      installedVersion,
      // An adopted pack is never offered an update: installing one would delete the directory
      // peon-ping put there, which `install` refuses anyway.
      updateAvailable:
        present && !adopted && installedVersion !== null && installedVersion !== entry.version,
      removable: present && recorded !== undefined && !adopted
    }
  }

  /** Fetches one sound straight from the repository, for previewing a pack before installing it. */
  async downloadPreview(entry: RegistryPack, file: string): Promise<string> {
    // Same containment rule, and the same `sounds/` default, the player applies on disk.
    const root = this.packDir(entry.name)
    const relativePath = relative(root, resolveSoundPath(root, file)).split(sep).join('/')

    const url = `https://raw.githubusercontent.com/${entry.source_repo}/${entry.source_ref}/${sourcePathOf(entry)}/${relativePath}`
    const response = await this.#fetchImpl(url)
    if (!response.ok) {
      throw new Error(`preview download failed with ${response.status}: ${url}`)
    }

    const dir = mkdtempSync(join(tmpdir(), 'peon-ping-preview-'))
    const target = join(dir, basename(relativePath))
    writeFileSync(target, Buffer.from(await response.arrayBuffer()))
    return target
  }

  async #record(name: string, fields: Omit<InstalledPack, 'name' | 'installedAt'>): Promise<void> {
    await this.#store.recordInstalled({ name, installedAt: this.#now(), ...fields })
  }
}

/** Moves a staged pack onto its final path, putting the previous one back if the move fails. */
function swapIntoPlace(staged: string, dest: string, previous: string): void {
  const hadPrevious = existsSync(dest)
  if (hadPrevious) {
    renameSync(dest, previous)
  }
  try {
    renameSync(staged, dest)
  } catch (err) {
    if (hadPrevious) {
      renameSync(previous, dest)
    }
    throw err
  }
}
