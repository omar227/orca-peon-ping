import { assert, test } from 'orca/testing'
import { SoundGate } from './gate.ts'

test('a second sound inside the global floor is dropped', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  assert.equal(g.allow('task.complete'), true)
  now = 400
  assert.equal(g.allow('task.error'), false)
  now = 600
  assert.equal(g.allow('task.error'), true)
})

test('input.required ignores the global floor', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  assert.equal(g.allow('task.acknowledge'), true)
  now = 400
  assert.equal(g.allow('input.required'), true)
})

test('input.required still honours its own debounce', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  assert.equal(g.allow('input.required'), true)
  now = 400
  assert.equal(g.allow('input.required'), false)
  now = 600
  assert.equal(g.allow('input.required'), true)
})

test('a preempting input.required resets the floor behind it', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  g.allow('task.acknowledge')
  now = 400
  g.allow('input.required')
  now = 700
  assert.equal(g.allow('task.complete'), false)
  now = 950
  assert.equal(g.allow('task.complete'), true)
})

test('a dropped sound does not move either clock', () => {
  let now = 0
  const g = new SoundGate({ now: () => now })
  g.allow('task.complete')
  now = 300
  assert.equal(g.allow('task.error'), false)
  now = 510
  assert.equal(g.allow('task.error'), true)
})
