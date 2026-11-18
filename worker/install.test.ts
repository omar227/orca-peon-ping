import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, assert, beforeEach, test } from 'orca/testing'
import {
  MAX_DOWNLOAD_BYTES,
  MAX_EXTRACTED_BYTES,
  PackInstaller,
  tarEntryTarget,
  verifySoundFile
} from './install.ts'
import { packDir, packsRoot } from './paths.ts'
import type { RegistryPack } from './registry.ts'
import { Store } from './store.ts'
import { memoryStoreApi } from './testing/memory-store.ts'

const ARCHIVE_ROOT = 'og-packs-1.1.0'

const entry: RegistryPack = {
  name: 'peon',
  display_name: 'Orc Peon',
  version: '1.0.0',
  trust_tier: 'official',
  categories: ['task.complete'],
  language: 'en',
  sound_count: 1,
  source_repo: 'PeonPing/og-packs',
  source_ref: 'v1.1.0',
  source_path: 'peon'
}

let tmpHome: string
const scratch: string[] = []

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'peon-home-'))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peon-fixture-'))
  scratch.push(dir)
  return dir
}

function manifestJson(name: string, version: string, soundFile: string): string {
  return JSON.stringify({
    cesp_version: '1.0',
    name,
    display_name: name,
    version,
    categories: { 'task.complete': { sounds: [{ file: soundFile }] } }
  })
}

/** Builds a GitHub-shaped tag archive and returns its bytes. */
function buildTarball(fill: (archiveRoot: string) => void, options?: { absolute?: boolean }): Buffer {
  const dir = scratchDir()
  const root = join(dir, ARCHIVE_ROOT)
  mkdirSync(root, { recursive: true })
  fill(root)
  const tarball = join(dir, 'fixture.tar.gz')
  const args = options?.absolute
    ? ['-czPf', tarball, root]
    : ['-czf', tarball, '-C', dir, ARCHIVE_ROOT]
  const result = spawnSync('tar', args, { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (result.status !== 0) {
    throw new Error(`tar fixture failed: ${result.stderr?.toString() ?? ''}`)
  }
  return readFileSync(tarball)
}

function packTarball(options?: { name?: string; version?: string; soundFile?: string }): Buffer {
  const name = options?.name ?? 'peon'
  const version = options?.version ?? '1.0.0'
  const soundFile = options?.soundFile ?? 'hello.wav'
  return buildTarball((root) => {
    const pack = join(root, name)
    mkdirSync(join(pack, 'sounds'), { recursive: true })
    writeFileSync(join(pack, 'openpeon.json'), manifestJson(name, version, soundFile))
    writeFileSync(join(pack, 'sounds', soundFile), 'fake-audio')
  })
}

function serving(bytes: Buffer): typeof fetch {
  return (async () => new Response(bytes)) as unknown as typeof fetch
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function packsRootEntries(): string[] {
  const root = packsRoot(tmpHome)
  return existsSync(root) ? readdirSync(root).sort() : []
}

function writeManifestAt(name: string, version: string): void {
  const dir = packDir(name, tmpHome)
  mkdirSync(join(dir, 'sounds'), { recursive: true })
  writeFileSync(join(dir, 'openpeon.json'), manifestJson(name, version, 'hello.wav'))
  writeFileSync(join(dir, 'sounds', 'hello.wav'), 'fake-audio')
}

// Review Focus 3
test('a tar entry escaping the destination is refused', () => {
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'peon/../../x']) {
    assert.throws(() => tarEntryTarget('/tmp/dest', bad))
  }
  assert.equal(tarEntryTarget('/tmp/dest', 'peon/sounds/a.wav'), '/tmp/dest/peon/sounds/a.wav')
})

test('install writes the pack and records its version', async () => {
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, {
    home: tmpHome,
    fetchImpl: serving(packTarball()),
    now: () => 1234
  })
  await installer.install(entry)
  assert.ok(existsSync(installer.manifestPath('peon')))
  assert.ok(existsSync(join(packDir('peon', tmpHome), 'sounds', 'hello.wav')))
  const recorded = (await store.getInstalled())['peon']
  assert.equal(recorded.version, entry.version)
  assert.equal(recorded.sourceRef, entry.source_ref)
  assert.equal(recorded.adopted, false)
  assert.equal(recorded.installedAt, 1234)
  assert.deepEqual(packsRootEntries(), ['peon'])
})

test('a failed install leaves no pack directory behind', async () => {
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, {
    home: tmpHome,
    fetchImpl: (async () => new Response('not a tarball')) as unknown as typeof fetch
  })
  await assert.rejects(() => installer.install(entry))
  assert.equal(existsSync(packDir('peon', tmpHome)), false)
  assert.deepEqual(await store.getInstalled(), {})
  assert.deepEqual(packsRootEntries(), [])
})

test('a non-200 tarball response is refused and leaves nothing behind', async () => {
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch
  })
  await assert.rejects(() => installer.install(entry), /404/)
  assert.deepEqual(packsRootEntries(), [])
})

test('a pack containing a symlink is refused and leaves nothing behind', async () => {
  const bytes = buildTarball((root) => {
    const pack = join(root, 'peon')
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(pack, 'openpeon.json'), manifestJson('peon', '1.0.0', 'hello.wav'))
    symlinkSync('/etc', join(pack, 'sounds'))
  })
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome, fetchImpl: serving(bytes) })
  await assert.rejects(() => installer.install(entry), /symbolic link/)
  assert.equal(existsSync(packDir('peon', tmpHome)), false)
  assert.deepEqual(await store.getInstalled(), {})
  assert.deepEqual(packsRootEntries(), [])
})

test('a pack containing a hard link is refused and leaves nothing behind', async () => {
  const bytes = buildTarball((root) => {
    const pack = join(root, 'peon')
    mkdirSync(join(pack, 'sounds'), { recursive: true })
    writeFileSync(join(pack, 'openpeon.json'), manifestJson('peon', '1.0.0', 'hello.wav'))
    writeFileSync(join(pack, 'sounds', 'hello.wav'), 'fake-audio')
    linkSync(join(pack, 'sounds', 'hello.wav'), join(pack, 'sounds', 'copy.wav'))
  })
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: serving(bytes)
  })
  await assert.rejects(() => installer.install(entry), /hard link/)
  assert.deepEqual(packsRootEntries(), [])
})

test('a tarball with absolute entry paths is refused', async () => {
  const bytes = buildTarball(
    (root) => {
      const pack = join(root, 'peon')
      mkdirSync(pack, { recursive: true })
      writeFileSync(join(pack, 'openpeon.json'), manifestJson('peon', '1.0.0', 'hello.wav'))
    },
    { absolute: true }
  )
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: serving(bytes)
  })
  await assert.rejects(() => installer.install(entry), /escapes|absolute/)
  assert.deepEqual(packsRootEntries(), [])
})

test('a pack with no manifest is refused', async () => {
  const bytes = buildTarball((root) => {
    const pack = join(root, 'peon', 'sounds')
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(pack, 'hello.wav'), 'fake-audio')
  })
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: serving(bytes)
  })
  await assert.rejects(() => installer.install(entry), /openpeon\.json/)
  assert.deepEqual(packsRootEntries(), [])
})

test('a manifest whose sha256 does not match the registry entry is refused', async () => {
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: serving(packTarball())
  })
  await assert.rejects(
    () => installer.install({ ...entry, manifest_sha256: 'deadbeef' }),
    /sha256/
  )
  assert.deepEqual(packsRootEntries(), [])
})

test('a manifest whose sha256 matches the registry entry is installed', async () => {
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: serving(packTarball())
  })
  const expected = sha256(manifestJson('peon', '1.0.0', 'hello.wav'))
  await installer.install({ ...entry, manifest_sha256: expected })
  assert.ok(existsSync(installer.manifestPath('peon')))
})

test('installing over an existing pack replaces it rather than merging', async () => {
  const store = new Store(memoryStoreApi())
  const first = new PackInstaller(store, { home: tmpHome, fetchImpl: serving(packTarball()) })
  await first.install(entry)

  const second = new PackInstaller(store, {
    home: tmpHome,
    fetchImpl: serving(packTarball({ version: '1.1.0', soundFile: 'bye.wav' }))
  })
  await second.install({ ...entry, version: '1.1.0' })

  const dir = packDir('peon', tmpHome)
  assert.ok(existsSync(join(dir, 'sounds', 'bye.wav')))
  assert.equal(existsSync(join(dir, 'sounds', 'hello.wav')), false)
  assert.equal((await store.getInstalled())['peon'].version, '1.1.0')
  assert.deepEqual(packsRootEntries(), ['peon'])
})

test('an existing pack directory is adopted, not overwritten', async () => {
  writeManifestAt('peon', '0.9.0')
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome })
  assert.equal(await installer.adoptIfPresent('peon'), true)
  const recorded = (await store.getInstalled())['peon']
  assert.equal(recorded.adopted, true)
  assert.equal(recorded.version, '0.9.0')
  assert.equal(readFileSync(installer.manifestPath('peon'), 'utf8').includes('0.9.0'), true)
  assert.equal((await installer.status(entry)).removable, false)
})

test('adoptIfPresent ignores a directory with no readable manifest', async () => {
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome })
  assert.equal(await installer.adoptIfPresent('nothing-here'), false)

  mkdirSync(packDir('broken', tmpHome), { recursive: true })
  writeFileSync(join(packDir('broken', tmpHome), 'openpeon.json'), 'not json')
  assert.equal(await installer.adoptIfPresent('broken'), false)
  assert.deepEqual(await store.getInstalled(), {})
})

test('adoptIfPresent leaves a pack this plugin installed alone', async () => {
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome, fetchImpl: serving(packTarball()) })
  await installer.install(entry)
  assert.equal(await installer.adoptIfPresent('peon'), false)
  assert.equal((await store.getInstalled())['peon'].adopted, false)
})

test('remove refuses an adopted pack and deletes an installed one', async () => {
  writeManifestAt('peon', '0.9.0')
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, {
    home: tmpHome,
    fetchImpl: serving(packTarball({ name: 'glados' }))
  })
  await installer.adoptIfPresent('peon')
  await installer.install({ ...entry, name: 'glados', source_path: 'glados' })

  await assert.rejects(() => installer.remove('peon'), /adopted/)
  assert.ok(existsSync(packDir('peon', tmpHome)))

  await installer.remove('glados')
  assert.equal(existsSync(packDir('glados', tmpHome)), false)
  assert.deepEqual(Object.keys(await store.getInstalled()), ['peon'])
})

test('remove refuses a pack this plugin never recorded', async () => {
  writeManifestAt('peon', '0.9.0')
  const installer = new PackInstaller(new Store(memoryStoreApi()), { home: tmpHome })
  await assert.rejects(() => installer.remove('peon'), /not installed/)
  assert.ok(existsSync(packDir('peon', tmpHome)))
})

test('status reports an update when the recorded version differs', async () => {
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome, fetchImpl: serving(packTarball()) })
  await installer.install(entry)
  assert.equal((await installer.status({ ...entry, version: '1.1.0' })).updateAvailable, true)
  assert.equal((await installer.status({ ...entry, version: '1.0.0' })).updateAvailable, false)
})

test('an adopted pack is never offered an update and never overwritten', async () => {
  writeManifestAt('peon', '0.9.0')
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, {
    home: tmpHome,
    fetchImpl: serving(packTarball({ version: '1.0.0' }))
  })
  assert.equal(await installer.adoptIfPresent('peon'), true)

  const status = await installer.status(entry)
  assert.equal(status.adopted, true)
  assert.equal(status.installedVersion, '0.9.0')
  assert.equal(status.updateAvailable, false)
  assert.equal(status.removable, false)

  await assert.rejects(() => installer.install(entry), /adopted/)
  assert.ok(readFileSync(installer.manifestPath('peon'), 'utf8').includes('0.9.0'))
  assert.equal((await store.getInstalled())['peon'].adopted, true)
  assert.deepEqual(packsRootEntries(), ['peon'])
})

test('a non-string manifest_sha256 is treated as absent rather than crashing', async () => {
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome, fetchImpl: serving(packTarball()) })
  await installer.install({ ...entry, manifest_sha256: null as unknown as string })
  assert.ok(existsSync(installer.manifestPath('peon')))
  assert.equal((await store.getInstalled())['peon'].manifestSha256, null)
})

test('status reports an uninstalled pack as absent and not removable', async () => {
  const installer = new PackInstaller(new Store(memoryStoreApi()), { home: tmpHome })
  assert.deepEqual(await installer.status(entry), {
    name: 'peon',
    present: false,
    adopted: false,
    installedVersion: null,
    updateAvailable: false,
    removable: false
  })
})

test('downloadPreview fetches one raw file into a temp path', async () => {
  const urls: string[] = []
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: (async (url: string) => {
      urls.push(String(url))
      return new Response('preview-audio')
    }) as unknown as typeof fetch
  })
  const path = await installer.downloadPreview(entry, 'PeonReady1.wav')
  scratch.push(dirname(path))
  assert.equal(readFileSync(path, 'utf8'), 'preview-audio')
  assert.equal(
    urls[0],
    'https://raw.githubusercontent.com/PeonPing/og-packs/v1.1.0/peon/sounds/PeonReady1.wav'
  )
})

test('downloadPreview refuses a file path that escapes the pack', async () => {
  const installer = new PackInstaller(new Store(memoryStoreApi()), { home: tmpHome })
  await assert.rejects(() => installer.downloadPreview(entry, '../../../etc/passwd'))
  await assert.rejects(() => installer.downloadPreview(entry, '/etc/passwd'))
})

test('verifySoundFile accepts a matching hash, rejects a wrong one, and passes when none is given', async () => {
  const file = join(tmpHome, 'a.wav')
  writeFileSync(file, 'abc')
  assert.equal(await verifySoundFile(file, sha256('abc')), true)
  assert.equal(await verifySoundFile(file, 'deadbeef'), false)
  assert.equal(await verifySoundFile(file, null), true)
  assert.equal(await verifySoundFile(join(tmpHome, 'missing.wav'), null), false)
})

/**
 * The cap the whole pipeline hangs on. `codeload.github.com` sends no `Content-Length` on a tag
 * archive, so this fixture does not either: the only thing that can stop it is counting bytes as
 * they arrive. It pushes past the real `MAX_DOWNLOAD_BYTES`, not an injected one, because a cap
 * that is only ever exercised at a test-sized value is a cap nobody has checked.
 */
function endlessStream(chunkBytes = 8 * 1024 * 1024): typeof fetch {
  return (async () => {
    const chunk = new Uint8Array(chunkBytes)
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk)
        }
      })
    )
  }) as unknown as typeof fetch
}

test('the download cap clears the default pack, which is 56 MB of archive', () => {
  // PeonPing/og-packs v1.0.0, the tag the registry pins `peon` to, measured against the real
  // host. A cap at or below 64 MB would break the first-run install this plugin depends on.
  assert.ok(
    MAX_DOWNLOAD_BYTES > 58_299_881,
    `the default pack's archive must fit under the cap; the cap is ${MAX_DOWNLOAD_BYTES}`
  )
  assert.ok(MAX_EXTRACTED_BYTES >= MAX_DOWNLOAD_BYTES)
})

test('an oversized download is refused and leaves the packs root empty', async () => {
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, { home: tmpHome, fetchImpl: endlessStream() })

  await assert.rejects(() => installer.install(entry), /larger than the 150 MB/)

  assert.equal(existsSync(packDir('peon', tmpHome)), false)
  assert.deepEqual(await store.getInstalled(), {})
  assert.deepEqual(packsRootEntries(), [])
})

/**
 * The extraction half, which is what a gzip bomb hits: a small archive, a large tree. The cap is
 * lowered for the test rather than unpacking 300 MB in a unit test — the mechanism, the error and
 * the cleanup are what this proves; `MAX_EXTRACTED_BYTES` itself is the number in the comment.
 */
test('a pack that unpacks past the extraction cap is refused and leaves nothing behind', async () => {
  const bytes = buildTarball((root) => {
    const pack = join(root, 'peon')
    mkdirSync(join(pack, 'sounds'), { recursive: true })
    writeFileSync(join(pack, 'openpeon.json'), manifestJson('peon', '1.0.0', 'hello.wav'))
    // Compresses to almost nothing and unpacks to 64 KB: a bomb in miniature.
    writeFileSync(join(pack, 'sounds', 'hello.wav'), 'a'.repeat(64 * 1024))
  })
  const store = new Store(memoryStoreApi())
  const installer = new PackInstaller(store, {
    home: tmpHome,
    fetchImpl: serving(bytes),
    maxExtractedBytes: 1024
  })

  await assert.rejects(() => installer.install(entry), /unpacks to/)

  assert.equal(existsSync(packDir('peon', tmpHome)), false)
  assert.deepEqual(await store.getInstalled(), {})
  assert.deepEqual(packsRootEntries(), [])
})

test('a pack under the extraction cap still installs', async () => {
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: serving(packTarball()),
    maxExtractedBytes: 1024 * 1024
  })
  await installer.install(entry)
  assert.ok(existsSync(installer.manifestPath('peon')))
})

test('install reports download progress as the bytes arrive', async () => {
  const seen: number[] = []
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: serving(packTarball())
  })

  await installer.install(entry, (downloaded) => seen.push(downloaded))

  assert.ok(seen.length > 0)
  assert.ok(seen[seen.length - 1] > 0)
  // Monotonic: it is a running total, not a per-chunk size.
  assert.deepEqual([...seen].sort((a, b) => a - b), seen)
})

test('repeated previews reuse one temp directory instead of leaking one each', async () => {
  const installer = new PackInstaller(new Store(memoryStoreApi()), {
    home: tmpHome,
    fetchImpl: (async () => new Response('preview-audio')) as unknown as typeof fetch
  })

  const first = await installer.downloadPreview(entry, 'PeonReady1.wav')
  const second = await installer.downloadPreview(entry, 'PeonReady2.wav')
  scratch.push(dirname(first))

  assert.equal(dirname(first), dirname(second))
  assert.notEqual(first, second)
  assert.equal(readFileSync(second, 'utf8'), 'preview-audio')
})
