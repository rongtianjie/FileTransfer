import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { Transfer, MAX_FILE, MAX_BATCH, CHUNK, WINDOW } from '../src/transfer.ts'

function pair(budget = () => undefined, unlimited = () => false) {
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
  const host = new Transfer(left, true, () => {}, budget, n => requests.push(n), undefined, undefined, unlimited)
  const guest = new Transfer(right, false, () => {}, budget, n => requests.push(n), undefined, undefined, unlimited)
  return { host, guest, left, right, requests }
}

test('both ends accept an oversized file offer only while the room is unlimited', async () => {
  let allowed = true
  const { host, guest } = pair(undefined, () => allowed)
  const oversized = { name: 'large.bin', size: MAX_FILE + 1 }
  assert.equal(host.offer(oversized), true)
  await until(() => guest.view.phase === 'offered')
  allowed = false
  guest.checkBudget()
  await until(() => host.view.phase === 'stopped')
  assert.equal(guest.view.phase, 'stopped')
  assert.equal(host.offer(oversized), false)
})

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

test('slow final close keeps both peers reserved past 60 seconds and can still succeed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, guest, left } = pair()
  t.after(() => { host.dispose(); guest.dispose() })
  let finishClose
  const closeGate = new Promise(resolve => { finishClose = resolve })
  const file = new File([], 'slow.txt')
  host.offer(file)
  await until(() => guest.view.phase === 'offered')
  await guest.accept(async () => ({ close: () => closeGate, async abort() {} }))
  await until(() => guest.view.phase === 'saving')
  t.mock.timers.tick(60_000)
  assert.equal(host.view.phase, 'confirming')
  assert.match(host.view.message, /仍在等待/)
  host.retry()
  assert.equal(host.offer(file), false)
  assert.equal(guest.offer(file), false)
  assert.equal(left.sent.some(data => typeof data === 'string' && JSON.parse(data).type === 'cancel'), false)
  finishClose()
  await until(() => host.view.phase === 'done')
  assert.equal(host.view.message, '')
  assert.equal(host.retryFile, undefined)
})

test('losing the connection during final confirmation leaves the result unknown and clears automatic retry', async () => {
  const { host, guest } = pair()
  let finishClose
  const closeGate = new Promise(resolve => { finishClose = resolve })
  host.offer(new File([], 'uncertain.txt'))
  await until(() => guest.view.phase === 'offered')
  await guest.accept(async () => ({ close: () => closeGate, async abort() {} }))
  await until(() => guest.view.phase === 'saving')
  host.dispose()
  guest.dispose()
  try {
    assert.equal(host.view.phase, 'unconfirmed')
    assert.equal(host.retryFile, undefined)
    assert.equal(guest.view.phase, 'saving')
  } finally {
    finishClose()
  }
  await until(() => guest.view.phase === 'done')
})

test('a receiver can cancel before finish arrives even if the sender has entered confirmation', async () => {
  const { host, guest, left, right } = pair()
  const deliver = left.send
  let finish
  left.send = function (data) {
    if (JSON.parse(data).type === 'finish') finish = data
    else deliver.call(this, data)
  }
  const file = new File([], 'empty.txt')
  host.offer(file)
  await until(() => guest.view.phase === 'offered')
  await guest.accept(async () => ({ async abort() {}, close() { assert.fail('cancelled file was saved') } }))
  await until(() => host.view.phase === 'confirming')
  guest.cancel()
  try {
    await until(() => host.view.phase === 'stopped')
  } finally {
    right.onmessage({ data: finish })
    host.dispose()
    guest.dispose()
  }
  assert.equal(host.retryFile, file)
})

test('an older receiver can report a final close failure using the legacy cancel message', async () => {
  const { host, guest, right } = pair()
  const send = right.send
  right.send = function (data) {
    const message = JSON.parse(data)
    if (message.type === 'cancel') {
      data = JSON.stringify({ type: 'cancel', id: message.id, message: '保存文件失败，请重新发送。' })
    }
    send.call(this, data)
  }
  const file = new File([], 'legacy.txt')
  host.offer(file)
  await until(() => guest.view.phase === 'offered')
  await guest.accept(async () => ({ async close() { throw new Error('disk failure') }, async abort() {} }))
  try {
    await until(() => host.view.phase === 'stopped')
    assert.match(host.view.message, /保存文件失败/)
    assert.equal(host.retryFile, file)
  } finally {
    host.dispose()
    guest.dispose()
  }
})

test('a send-only browser refuses incoming offers and can still send', async () => {
  const { host, guest } = pair()
  guest.canReceive = false
  host.offer(new File(['a'], 'to-phone.txt'))
  await until(() => host.view.phase === 'stopped')
  assert.match(host.view.message, /只能发送文件/)
  assert.equal(guest.view.phase, 'idle')
  guest.offer(new File(['b'], 'from-phone.txt'))
  await until(() => host.view.phase === 'offered')
  await host.accept(async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }))
  await until(() => guest.view.phase === 'done')
})

function memoryFolder() {
  const files = new Map()
  const open = async name => {
    const chunks = []
    files.set(name, chunks)
    return { write: async bytes => { chunks.push(new Uint8Array(bytes)) }, close: async () => {}, abort: async () => {} }
  }
  return { files, open }
}

test('a batch is accepted once and the rest saves into the same folder without prompting', async () => {
  const { host, guest } = pair()
  const folder = memoryFolder()
  assert.equal(host.offerFiles([new File(['one'], 'a.txt'), new File(['two!'], 'b.txt'), new File([''], 'c.txt')]), true)
  await until(() => guest.view.phase === 'offered')
  assert.equal(guest.view.batchIndex, 1)
  assert.equal(guest.view.batchTotal, 3)
  await guest.acceptBatch(folder.open)
  await until(() => host.view.phase === 'done' && host.view.message === '已发送 3 个文件。')
  await until(() => guest.view.phase === 'done')
  assert.deepEqual([...folder.files.keys()], ['a.txt', 'b.txt', 'c.txt'])
  assert.equal(new TextDecoder().decode(folder.files.get('b.txt')[0]), 'two!')
  assert.equal(guest.view.message, '已接收 3 个文件。')
  assert.equal(host.canOffer, true)
  // The folder is released with the batch, so the next offer asks again.
  host.offer(new File(['x'], 'later.txt'))
  await until(() => guest.view.phase === 'offered')
  host.dispose(); guest.dispose()
})

test('cancelling mid-batch stops the remaining files and reports progress', async () => {
  const { host, guest } = pair()
  const folder = memoryFolder()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const open = async name => {
    const writer = await folder.open(name)
    return name === 'b.txt' ? { ...writer, write: async bytes => { await gate; await writer.write(bytes) } } : writer
  }
  host.offerFiles([new File(['1'], 'a.txt'), new File(['2'], 'b.txt'), new File(['3'], 'c.txt')])
  await until(() => guest.view.phase === 'offered')
  await guest.acceptBatch(open)
  await until(() => guest.view.name === 'b.txt' && guest.view.phase === 'receiving')
  guest.cancel()
  release()
  await until(() => host.view.phase === 'stopped')
  assert.match(host.view.message, /已完成 1 \/ 3 个文件/)
  assert.equal(folder.files.has('c.txt'), false)
  assert.equal(host.canOffer, true)
  host.dispose(); guest.dispose()
})

test('retry after a declined batch resends every file that was not sent', async () => {
  const { host, guest } = pair()
  host.offerFiles([new File(['1'], 'a.txt'), new File(['2'], 'b.txt')])
  await until(() => guest.view.phase === 'offered')
  guest.cancel()
  await until(() => host.view.phase === 'stopped')
  host.retry()
  await until(() => guest.view.phase === 'offered')
  assert.equal(guest.view.name, 'a.txt')
  assert.equal(guest.view.batchTotal, 2)
  host.dispose(); guest.dispose()
})

test('retry after an interruption part-way resumes with the unsent files only', async () => {
  const { host, guest } = pair()
  const folder = memoryFolder()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const open = async name => {
    const writer = await folder.open(name)
    return name === 'b.txt' ? { ...writer, write: async bytes => { await gate; await writer.write(bytes) } } : writer
  }
  host.offerFiles([new File(['1'], 'a.txt'), new File(['2'], 'b.txt'), new File(['3'], 'c.txt')])
  await until(() => guest.view.phase === 'offered')
  await guest.acceptBatch(open)
  await until(() => guest.view.name === 'b.txt' && guest.view.phase === 'receiving')
  guest.cancel()
  release()
  await until(() => host.view.phase === 'stopped')
  host.retry()
  await until(() => guest.view.phase === 'offered')
  assert.equal(guest.view.name, 'b.txt')
  assert.equal(guest.view.batchIndex, 1)
  assert.equal(guest.view.batchTotal, 2)
  host.dispose(); guest.dispose()
})

test('a single file still retries on its own', async () => {
  const { host, guest } = pair()
  host.offer(new File(['1'], 'only.txt'))
  await until(() => guest.view.phase === 'offered')
  guest.cancel()
  await until(() => host.view.phase === 'stopped')
  host.retry()
  await until(() => guest.view.phase === 'offered')
  assert.equal(guest.view.batchTotal, undefined)
  host.dispose(); guest.dispose()
})

test('batch limits and malformed batch metadata are handled', async () => {
  const { host, guest, left } = pair()
  const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => new File([''], `${i}.txt`))
  assert.equal(host.offerFiles(many), false)
  assert.match(host.view.message, /最多/)
  // A bad batch field degrades to an ordinary single-file offer.
  left.send(JSON.stringify({ type: 'offer', id: 1, name: 'x.txt', size: 1, batch: { id: 1, index: 9, count: 2 } }))
  await until(() => guest.view.phase === 'offered')
  assert.equal(guest.view.batchTotal, undefined)
  host.dispose(); guest.dispose()
})

test('a quota failure part-way through a batch stops it with the progress made', async () => {
  const { host, guest } = pair(() => 100)
  const folder = memoryFolder()
  host.offerFiles([new File(['1'], 'a.txt'), new File([new Uint8Array(500)], 'big.bin')])
  await until(() => guest.view.phase === 'offered')
  await guest.acceptBatch(folder.open)
  await until(() => host.view.phase === 'stopped')
  assert.equal(host.canOffer, true)
  assert.equal(folder.files.has('big.bin'), false)
  host.dispose(); guest.dispose()
})

test('a file larger than this device can take is refused with a clear reason', async () => {
  const { host, guest } = pair()
  let limit = 10
  guest.receiveLimit = () => limit
  host.offer(new File([new Uint8Array(11)], 'big.bin'))
  await until(() => host.view.phase === 'stopped')
  assert.match(host.view.message, /超出对方设备/)
  assert.equal(guest.view.phase, 'idle')
  limit = 11
  host.retry()
  await until(() => guest.view.phase === 'offered')
  guest.cancel()
  await until(() => host.view.phase === 'stopped')
})

test('the unsent files can be handed to a new transfer after a reconnect', async () => {
  const first = pair()
  first.host.offerFiles([new File(['1'], 'a.txt'), new File(['2'], 'b.txt'), new File(['3'], 'c.txt')])
  await until(() => first.guest.view.phase === 'offered')
  first.guest.cancel()
  await until(() => first.host.view.phase === 'stopped')
  const pending = first.host.retryFiles
  assert.deepEqual(pending.map(file => file.name), ['a.txt', 'b.txt', 'c.txt'])
  first.host.dispose(); first.guest.dispose()
  const second = pair()
  second.host.retryFiles = pending
  second.host.retry()
  await until(() => second.guest.view.phase === 'offered')
  assert.equal(second.guest.view.batchTotal, 3)
  second.host.dispose(); second.guest.dispose()
})
