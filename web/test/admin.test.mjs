import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mountAdminEntry } from '../src/admin/entry.ts'
import { adminRequest, cancelTimeZonePayload, configPayload, formatQuotaInput, quotaInputBytes, seriesRuns } from '../src/admin/model.ts'
import { formatBytes } from '../src/admin/traffic.ts'

const emptyConfig = { publicLimit: 1, reservedLimit: 2, keyVersion: 0 }

test('config accepts zero and exactly one PiB in integer bytes', () => {
  assert.deepEqual(configPayload('0', '1125899906842624', 'keep', 'ignored', emptyConfig), {
    publicLimit: 0, reservedLimit: 1125899906842624, expected: { publicLimit: 1, reservedLimit: 2 },
  })
  for (const invalid of ['', '-1', '1.5', '1e6', '1125899906842625']) {
    assert.throws(() => configPayload(invalid, '0', 'keep', '', emptyConfig), RangeError)
  }
})

test('quota inputs accept decimal MB and GB without losing byte precision', () => {
  assert.deepEqual(configPayload(' 1.234567891 gb ', '0.000001 MB', 'keep', '', emptyConfig), {
    publicLimit: 1234567891, reservedLimit: 1, expected: { publicLimit: 1, reservedLimit: 2 },
  })
  for (const invalid of ['0.0000001 MB', '1125899.906842625 GB', '1.5 XB']) {
    assert.throws(() => configPayload(invalid, '0 MB', 'keep', '', emptyConfig), RangeError)
  }
  assert.equal(configPayload('0.000001 MB', '0.000002 MB', 'keep', '', emptyConfig), null)
  for (const [bytes, display] of [
    [0, '0 MB'], [1, '0.000001 MB'], [999999999, '999.999999 MB'],
    [1000000000, '1 GB'], [20000000000, '20 GB'], [2 ** 50, '1125899.906842624 GB'],
  ]) {
    assert.equal(formatQuotaInput(bytes), display)
    assert.equal(quotaInputBytes(display), bytes)
  }
})

test('traffic uses at most one decimal place and keeps tiny amounts visible', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1), '1 B')
  assert.equal(formatBytes(12345), '12.3 kB')
  assert.equal(formatBytes(100000000), '100 MB')
  assert.equal(formatBytes(123456789), '123.5 MB')
  assert.equal(formatBytes(500000000), '500 MB')
  assert.equal(formatBytes(1000000000), '1 GB')
  assert.equal(formatBytes(1234567890), '1.2 GB')
  assert.equal(formatBytes(20000000000), '20 GB')
  assert.equal(formatBytes(null), '无数据')
})

test('config sends a key only when replacing it, preserving the supplied bytes', () => {
  assert.deepEqual(configPayload('1', '2', 'replace', ' key ', emptyConfig), {
    keyAction: 'replace', key: ' key ', expected: { keyVersion: 0 },
  })
  assert.throws(() => configPayload('1', '2', 'replace', '', emptyConfig), RangeError)
  assert.throws(() => configPayload('1', '2', 'replace', '   ', emptyConfig), RangeError)
  assert.throws(() => configPayload('1', '2', 'replace', '钥'.repeat(171), emptyConfig), RangeError)
  assert.deepEqual(configPayload('1', '2', 'clear', 'ignored', emptyConfig), {
    keyAction: 'clear', expected: { keyVersion: 0 },
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

test('settings edits send only touched fields with their original values', () => {
  const expected = { publicLimit: 100, reservedLimit: 50, keyVersion: 2 }
  assert.deepEqual(configPayload('0', '50', 'keep', '', expected), {
    publicLimit: 0, expected: { publicLimit: 100 },
  })
  assert.deepEqual(configPayload('100', '50', 'replace', ' next ', expected), {
    keyAction: 'replace', key: ' next ', expected: { keyVersion: 2 },
  })
  assert.equal(configPayload('0100', '50', 'keep', '', expected), null)
})

test('homepage admin discovery offers an accessible retry after a sustained initial failure', async t => {
  function control(children = {}) {
    const listeners = new Map()
    return {
      hidden: false,
      attributes: new Map(),
      querySelector: selector => children[selector],
      addEventListener: (event, listener) => listeners.set(event, listener),
      emit: event => listeners.get(event)?.(),
      setAttribute(name, value) { this.attributes.set(name, value) },
      removeAttribute(name) { this.attributes.delete(name) },
      focus() { this.focused = true },
    }
  }

  const label = control()
  const tooltip = control()
  const button = control({ span: label, '[role="tooltip"]': tooltip })
  button.setAttribute('aria-haspopup', 'dialog')
  const link = control()
  const form = control({
    '[name="username"]': control(),
    '[name="password"]': control(),
    'button[type="submit"]': control(),
    'button[type="button"]': control(),
    '[role="status"]': control(),
  })
  const dialog = control({ form })
  dialog.showModal = () => { dialog.open = true }
  const page = control({ ':scope > button': button, a: link, dialog })

  const timers = []
  const totals = control()
  totals.hidden = true
  const totalsRequests = []
  const browser = control()
  browser.setTimeout = callback => timers.push(callback)
  browser.setInterval = () => {}
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/admin/relay-totals') {
      totalsRequests.push(JSON.parse(options.body))
      return Response.json({ today: 123456789, month: 2456789012 })
    }
    const next = responses.shift()
    if (next instanceof Error) throw next
    return new Response(null, { status: next })
  })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })

  const responses = [503, new Error('offline'), 204, 502, 502, 401, 404]
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const syncRoom = mountAdminEntry(page, totals)
  syncRoom('room-proof')
  await settle()
  assert.equal(timers.length, 1)
  timers.shift()()
  await settle()
  assert.equal(page.hidden, false)
  assert.equal(button.hidden, false)
  assert.equal(link.hidden, true)
  assert.equal(totals.hidden, true)
  assert.deepEqual(totalsRequests, [])
  assert.equal(label.textContent, '重试管理后台')
  assert.equal(button.attributes.get('aria-label'), label.textContent)
  assert.match(tooltip.textContent, /重新检查/)
  assert.equal(button.attributes.has('aria-haspopup'), false)

  button.emit('click')
  await settle()
  assert.equal(dialog.open, undefined)
  assert.equal(button.hidden, true)
  assert.equal(link.hidden, false)
  assert.equal(link.focused, true)
  assert.equal(totals.hidden, false)
  assert.equal(totals.textContent, '今日中继 123.5 MB · 本月中继 2.5 GB')
  assert.deepEqual(totalsRequests, [{ adminProof: 'room-proof' }])

  browser.emit('focus')
  await settle()
  timers.shift()()
  await settle()
  assert.equal(link.hidden, false)

  browser.emit('focus')
  await settle()
  assert.equal(button.hidden, false)
  assert.equal(label.textContent, '管理后台')
  assert.equal(totals.hidden, true)
  assert.equal(totals.textContent, '')
  assert.equal(button.attributes.get('aria-label'), label.textContent)
  assert.match(tooltip.textContent, /登录/)
  assert.equal(button.attributes.get('aria-haspopup'), 'dialog')
  button.emit('click')
  assert.equal(dialog.open, true)

  dialog.open = false
  browser.emit('focus')
  await settle()
  assert.equal(page.hidden, true)
  assert.equal(responses.length, 0)
})

test('cancelling a time-zone change carries the displayed schedule and its exact timestamp', () => {
  const timeZoneEffectiveAt = '2026-11-22T16:00:00.123456789Z'
  const pendingTimeZone = 'Asia/Shanghai'
  assert.deepEqual(cancelTimeZonePayload({ pendingTimeZone, timeZoneEffectiveAt }), {
    action: 'cancel',
    expectedPendingTimeZone: pendingTimeZone,
    expectedTimeZoneEffectiveAt: timeZoneEffectiveAt,
  })
  assert.equal(cancelTimeZonePayload({ timeZoneEffectiveAt }), null)
  assert.equal(cancelTimeZonePayload({ pendingTimeZone }), null)
})
