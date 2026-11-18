import { assert, test } from 'orca/testing'
import { PaneTracker } from './mapping.ts'
import type { AgentStatusEvent, TurnOutcome } from './mapping.ts'

const ev = (over: Partial<AgentStatusEvent> = {}): AgentStatusEvent =>
  ({ paneKey: 'tab-1:pane-1', state: 'working', sessionId: 's1', ...over })

test('first working for a session is session.start', () => {
  assert.equal(new PaneTracker().observe(ev()), 'session.start')
})

test('a later return to working is task.acknowledge', () => {
  const t = new PaneTracker()
  t.observe(ev())
  t.observe(ev({ state: 'done', mainAgent: { state: 'done', outcome: 'success' } }))
  assert.equal(t.observe(ev()), 'task.acknowledge')
})

test('a new sessionId in the same pane is session.start again', () => {
  const t = new PaneTracker()
  t.observe(ev())
  t.observe(ev({ state: 'done', mainAgent: { state: 'done', outcome: 'success' } }))
  assert.equal(t.observe(ev({ sessionId: 's2' })), 'session.start')
})

test('blocked and waiting both map to input.required', () => {
  assert.equal(new PaneTracker().observe(ev({ state: 'blocked' })), 'input.required')
  assert.equal(new PaneTracker().observe(ev({ state: 'waiting' })), 'input.required')
})

test('done with success is task.complete and with failure is task.error', () => {
  const done = (outcome: TurnOutcome) =>
    new PaneTracker().observe(ev({ state: 'done', mainAgent: { state: 'done', outcome } }))
  assert.equal(done('success'), 'task.complete')
  assert.equal(done('failure'), 'task.error')
})

test('done with no outcome at all is task.complete', () => {
  assert.equal(new PaneTracker().observe(ev({ state: 'done' })), 'task.complete')
  assert.equal(
    new PaneTracker().observe(ev({ state: 'done', mainAgent: { state: 'done' } })),
    'task.complete'
  )
})

test('a stopped turn is silent', () => {
  for (const outcome of ['cancellation', 'interruption', 'superseded', 'unconfirmed'] as const) {
    assert.equal(
      new PaneTracker().observe(ev({ state: 'done', mainAgent: { state: 'done', outcome } })),
      null
    )
  }
})

// Review Focus 1
test('a repeated event in the same state fires nothing', () => {
  const t = new PaneTracker()
  assert.equal(t.observe(ev({ state: 'working' })), 'session.start')
  assert.equal(t.observe(ev({ state: 'working' })), null)
  assert.equal(t.observe(ev({ state: 'working' })), null)
})

test('panes untouched past the ttl are evicted', () => {
  let now = 0
  const t = new PaneTracker({ ttlMs: 1000, now: () => now })
  t.observe(ev())
  now = 2000
  t.observe(ev({ paneKey: 'tab-2:pane-2', sessionId: 's9' }))
  assert.equal(t.size, 1)
})

test('the pane map is capped at maxPanes', () => {
  const t = new PaneTracker({ maxPanes: 2 })
  for (const n of [1, 2, 3, 4]) t.observe(ev({ paneKey: `p${n}`, sessionId: `s${n}` }))
  assert.ok(t.size <= 2)
})
