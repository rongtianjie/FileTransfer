import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminRequest, configPayload, seriesRuns } from '../src/admin/model.ts'

test('config accepts zero and exactly one PiB in integer bytes', () => {
  assert.deepEqual(configPayload('0', '1125899906842624', 'keep', 'ignored'), {
    publicLimit: 0, reservedLimit: 1125899906842624, keyAction: 'keep',
  })
  for (const invalid of ['', '-1', '1.5', '1e6', '1125899906842625']) {
    assert.throws(() => configPayload(invalid, '0', 'keep', ''), RangeError)
  }
})

test('config sends a key only when replacing it, preserving the supplied bytes', () => {
  assert.deepEqual(configPayload('1', '2', 'replace', ' key '), {
    publicLimit: 1, reservedLimit: 2, keyAction: 'replace', key: ' key ',
  })
  assert.throws(() => configPayload('1', '2', 'replace', ''), RangeError)
  assert.throws(() => configPayload('1', '2', 'replace', '   '), RangeError)
  assert.throws(() => configPayload('1', '2', 'replace', '钥'.repeat(171)), RangeError)
  assert.deepEqual(configPayload('1', '2', 'clear', 'ignored'), {
    publicLimit: 1, reservedLimit: 2, keyAction: 'clear',
  })
})

test('traffic series keep observed zeroes and leave gaps at unknown dates', () => {
  assert.deepEqual(seriesRuns([null, 0, 12, null, 0, null]), [
    [{ index: 1, bytes: 0 }, { index: 2, bytes: 12 }], [{ index: 4, bytes: 0 }],
  ])
})

test('admin requests handle an empty success and preserve JSON API errors and status', async () => {
  const logout = await adminRequest(Promise.resolve(new Response(null, { status: 204 })))
  assert.equal(logout, undefined)
  await assert.rejects(
    adminRequest(Promise.resolve(new Response(JSON.stringify({ error: 'expired' }), { status: 401 }))),
    { status: 401, message: 'expired' },
  )
})
