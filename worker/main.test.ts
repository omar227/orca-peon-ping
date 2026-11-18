import { assert, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'

test('the worker activates without refusals', async () => {
  const worker = await mountWorker(main)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
