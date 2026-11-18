import { assert, test } from 'orca/testing'
import { packDir } from './paths.ts'

test('packDir builds a path under ~/.openpeon/packs', () => {
  assert.equal(packDir('peon', '/Users/x'), '/Users/x/.openpeon/packs/peon')
})

test('packDir refuses a name that is not a plain pack id', () => {
  for (const bad of ['../evil', 'a/b', '.hidden', 'UPPER', '']) {
    assert.throws(() => packDir(bad, '/Users/x'))
  }
})
