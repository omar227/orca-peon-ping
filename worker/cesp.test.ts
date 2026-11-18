import { assert, test } from 'orca/testing'
import type { CespManifest } from './cesp.ts'
import { coveredCategories, parseManifest, pickSound, resolveCategory, resolveSoundPath } from './cesp.ts'

const manifest: CespManifest = {
  cesp_version: '1.0',
  name: 'peon',
  categories: {
    'task.complete': { sounds: [{ file: 'sounds/JobsDone.wav' }, { file: 'sounds/WorkComplete.wav' }] },
    'task.error': { sounds: [] },
    greeting: { sounds: [{ file: 'Hello.wav' }] }
  },
  category_aliases: { 'session.start': 'greeting' }
}

test('a present category returns its sounds', () => {
  assert.equal(resolveCategory(manifest, 'task.complete').length, 2)
})

test('an absent category falls through category_aliases', () => {
  assert.deepEqual(resolveCategory(manifest, 'session.start'), [{ file: 'Hello.wav' }])
})

test('an unknown category returns nothing', () => {
  assert.deepEqual(resolveCategory(manifest, 'resource.limit'), [])
})

// Review Focus 5
test('a category with an empty sounds array returns nothing', () => {
  assert.deepEqual(resolveCategory(manifest, 'task.error'), [])
  assert.equal(pickSound(resolveCategory(manifest, 'task.error'), null), null)
})

test('a file with no slash is resolved under sounds/', () => {
  assert.equal(resolveSoundPath('/packs/peon', 'Hello.wav'), '/packs/peon/sounds/Hello.wav')
})

test('a file with a slash is resolved as given', () => {
  assert.equal(resolveSoundPath('/packs/peon', 'sounds/a.wav'), '/packs/peon/sounds/a.wav')
})

// Review Focus 2
test('a file escaping the pack directory is refused', () => {
  for (const bad of ['../../../.ssh/id_rsa', '/etc/passwd', 'sounds/../../x.wav']) {
    assert.throws(() => resolveSoundPath('/packs/peon', bad))
  }
})

test('pickSound avoids the last file when another exists', () => {
  for (let i = 0; i < 20; i++) {
    const picked = pickSound(resolveCategory(manifest, 'task.complete'), 'sounds/JobsDone.wav')
    assert.equal(picked?.file, 'sounds/WorkComplete.wav')
  }
})

test('pickSound replays the only sound rather than going silent', () => {
  assert.equal(pickSound([{ file: 'a.wav' }], 'a.wav')?.file, 'a.wav')
})

test('parseManifest rejects non-JSON and manifests with no name', () => {
  assert.throws(() => parseManifest('<!DOCTYPE html>'))
  assert.throws(() => parseManifest('{"cesp_version":"1.0"}'))
})

test('coveredCategories lists only categories with at least one sound', () => {
  assert.deepEqual(
    coveredCategories(manifest, ['session.start', 'task.complete', 'task.error']),
    ['session.start', 'task.complete']
  )
})
