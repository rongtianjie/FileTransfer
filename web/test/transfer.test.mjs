import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { Transfer, MAX_FILE, CHUNK, WINDOW } from '../src/transfer.ts'

function pair(budget = () => undefined) {
  const create = () => ({
    readyState: 'open',
    bufferedAmount: 0,
    sent: [],
    send(data) {
      this.sent.push(data)
      queueMicrotask(() => this.other.onmessage({ data }))
    },
  })
  const left = create()
  const right = create()
  left.other = right
  right.other = left
  const requests = []
  const host = new Transfer(left, true, () => {}, budget, n => requests.push(n))
  const guest = new Transfer(right, false, () => {}, budget, n => requests.push(n))
  return { host, guest, left, right, requests }
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await wait(5)
  }
  assert.fail('expected transfer state was not reached')
}

test('disk writes release credit, and only close completes the transfer', async () => {
  const { host, guest } = pair()
  let releaseWrite, releaseClose
  const writeGate = new Promise(resolve => { releaseWrite = resolve })
  const closeGate = new Promise(resolve => { releaseClose = resolve })
  const size = WINDOW + CHUNK
  const source = new Uint8Array(size).map((_, index) => index % 251)
  host.offer(new File([source], 'large.bin'))
  await until(() => guest.view.phase === 'offered')
  let written = 0
  await guest.accept(async () => ({
    async write(bytes) {
      await writeGate
      assert.deepEqual(bytes, source.slice(written, written + bytes.byteLength))
      written += bytes.byteLength
    },
    close: () => closeGate,
    abort: async () => {},
  }))
  await until(() => host.view.sent === WINDOW)
  assert.equal(host.view.bytes, 0)
  assert.equal(guest.view.bytes, 0)
  releaseWrite()
  await until(() => guest.view.phase === 'saving')
  assert.equal(host.view.bytes, size)
  assert.equal(host.view.phase, 'confirming')
  host.cancel()
  assert.equal(host.view.phase, 'confirming')
  releaseClose()
  await until(() => host.view.phase === 'done')
  assert.equal(guest.view.phase, 'done')
})

test('simultaneous offers select the host and the guest can retry its file', async () => {
  const { host, guest } = pair()
  host.offer(new File(['a'], 'host.txt'))
  guest.offer(new File(['b'], 'guest.txt'))
  await until(() => guest.view.phase === 'offered')
  assert.equal(guest.view.name, 'host.txt')
  guest.cancel()
  await until(() => host.view.phase === 'stopped')
  guest.retry()
  await until(() => host.view.phase === 'offered')
  assert.equal(host.view.name, 'guest.txt')
  host.cancel()
})

test('cancellation discards a late save picker and allows another offer', async () => {
  const { host, guest } = pair()
  host.offer(new File([], 'empty.txt'))
  await until(() => guest.view.phase === 'offered')
  let resolve, aborted = false
  const pending = guest.accept(() => new Promise(done => { resolve = done }))
  host.cancel()
  await until(() => guest.view.phase === 'stopped')
  resolve({ abort: async () => { aborted = true } })
  await pending
  assert.equal(aborted, true)
  host.retry()
  await until(() => guest.view.phase === 'offered')
  await guest.accept(async () => ({ close: async () => {} }))
  await until(() => host.view.phase === 'done')
})

test('the size limit includes exactly 2 GiB and relay credit is checked before offering', async () => {
  const { host, guest, requests } = pair(() => MAX_FILE - 1)
  const file = { size: MAX_FILE, name: 'limit.bin' }
  assert.equal(guest.offer({ ...file, size: MAX_FILE + 1 }), false)
  assert.equal(guest.offer(file), false)
  assert.equal(guest.retryFile, file)
  guest.requestUpgrade()
  await until(() => requests.length === 2)
  assert.deepEqual(requests, [MAX_FILE, MAX_FILE])
  assert.equal(host.view.phase, 'idle')
})

test('sending stops at the data-channel buffer threshold and resumes on drain', async () => {
  const { host, guest, left } = pair()
  left.bufferedAmount = 256 * 1024
  host.offer(new File([new Uint8Array(CHUNK)], 'paced.bin'))
  await until(() => guest.view.phase === 'offered')
  let written = 0
  await guest.accept(async () => ({
    async write(bytes) { written += bytes.byteLength },
    async close() {},
    async abort() {},
  }))
  await until(() => host.view.phase === 'sending')
  assert.equal(host.view.sent, 0)
  left.bufferedAmount = 0
  left.onbufferedamountlow()
  await until(() => host.view.phase === 'done')
  assert.equal(written, CHUNK)
})

test('receiver rejects a peer exceeding its write window and aborts the output', async () => {
  const { host, guest, right } = pair()
  host.offer(new File([new Uint8Array(WINDOW + CHUNK)], 'overflow.bin'))
  await until(() => guest.view.phase === 'offered')
  let aborted = false
  let release
  const writeGate = new Promise(resolve => { release = resolve })
  await guest.accept(async () => ({
    write: () => writeGate,
    async close() { assert.fail('invalid transfer was saved') },
    async abort() { aborted = true },
  }))
  const frame = new ArrayBuffer(CHUNK + 4)
  new DataView(frame).setUint32(0, 1)
  for (let i = 0; i <= WINDOW / CHUNK; i++) right.onmessage({ data: frame })
  assert.equal(guest.view.phase, 'stopped')
  assert.equal(guest.view.bytes, 0)
  assert.equal(aborted, true)
  release()
  await until(() => host.view.phase === 'stopped')
})

test('a failed stream close stops both peers and preserves the sender file', async () => {
  const { host, guest } = pair()
  const file = new File(['final'], 'close.txt')
  host.offer(file)
  await until(() => guest.view.phase === 'offered')
  await guest.accept(async () => ({
    async write() {},
    async close() { throw new Error('disk failure') },
    async abort() {},
  }))
  await until(() => host.view.phase === 'stopped')
  assert.equal(guest.view.phase, 'stopped')
  assert.equal(host.retryFile, file)
})
