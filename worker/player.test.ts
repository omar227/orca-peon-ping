import { assert, test } from 'orca/testing'
import { createPlayer, spawnDetached, type SpawnFn } from './player.ts'

const calls: { command: string; args: readonly string[] }[] = []
const spy: SpawnFn = (command, args) => { calls.push({ command, args }) }

test('darwin spawns afplay with the volume and path as separate arguments', () => {
  calls.length = 0
  createPlayer('darwin', spy).play('/packs/peon/sounds/Job s Done.wav', 0.5)
  assert.deepEqual(calls, [
    { command: 'afplay', args: ['-v', '0.50', '/packs/peon/sounds/Job s Done.wav'] }
  ])
})

test('volume is clamped to 0..1', () => {
  calls.length = 0
  createPlayer('darwin', spy).play('/a.wav', 5)
  createPlayer('darwin', spy).play('/a.wav', -1)
  assert.equal(calls[0].args[1], '1.00')
  assert.equal(calls[1].args[1], '0.00')
})

test('an unsupported platform plays nothing and says why', () => {
  calls.length = 0
  const player = createPlayer('linux', spy)
  player.play('/a.wav', 0.5)
  assert.equal(calls.length, 0)
  assert.equal(player.kind, 'unsupported')
  assert.equal(player.unavailableReason, 'Audio playback is macOS-only in this version.')
})

test('a supported player reports no reason', () => {
  assert.equal(createPlayer('darwin', spy).unavailableReason, null)
})

test('a command that cannot launch is reported instead of crashing the worker', async () => {
  const errors: Error[] = []
  spawnDetached((error) => errors.push(error))('peon-ping-no-such-command', [])
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(errors.length, 1)
})
