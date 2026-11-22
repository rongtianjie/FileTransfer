import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEMORY_LIMIT, clearStaleReceived, detectReceiveMode, memoryWriter, opfsWriter, receiveLimit } from '../src/receive.ts'

test('receive mode prefers streaming saves, then private storage, then memory', () => {
  assert.equal(detectReceiveMode({ picker: true, opfs: true }), 'picker')
  assert.equal(detectReceiveMode({ picker: false, opfs: true }), 'opfs')
  assert.equal(detectReceiveMode({ picker: false, opfs: false }), 'memory')
})

test('receive limits follow the storage the mode uses', () => {
  assert.equal(receiveLimit('picker'), Infinity)
  assert.equal(receiveLimit('memory', { quota: 1e12, usage: 0 }), MEMORY_LIMIT)
  assert.equal(receiveLimit('opfs'), Infinity)
  assert.equal(receiveLimit('opfs', { quota: 1_000_000_000, usage: 400_000_000 }), 600_000_000 - 64 * 1024 * 1024)
  assert.equal(receiveLimit('opfs', { quota: 10, usage: 1000 }), 0)
})

test('memory writer reassembles chunks across block boundaries in order', async () => {
  let received
  const writer = memoryWriter('a.bin', file => { received = file })
  const source = new Uint8Array(9 * 1024 * 1024).map((_, i) => i % 251)
  for (let at = 0; at < source.length; at += 32 * 1024) await writer.write(source.slice(at, at + 32 * 1024))
  await writer.close()
  assert.equal(received.name, 'a.bin')
  assert.equal(received.size, source.length)
  assert.deepEqual(new Uint8Array(await received.blob.arrayBuffer()), source)
})

test('memory writer abort drops the data and never reports a file', async () => {
  let received
  const writer = memoryWriter('a.bin', file => { received = file })
  await writer.write(new Uint8Array(10))
  await writer.abort()
  assert.equal(received, undefined)
})

function fakeRoot() {
  const files = new Map()
  const folder = {
    async getFileHandle(id, { create } = {}) {
      if (!files.has(id)) {
        if (!create) throw new DOMException('missing', 'NotFoundError')
        files.set(id, { chunks: [], lastModified: Date.now() })
      }
      const entry = files.get(id)
      return {
        kind: 'file', name: id,
        async createWritable() {
          return { async write(bytes) { entry.chunks.push(bytes) }, async close() {}, async abort() {} }
        },
        async getFile() { return Object.assign(new Blob(entry.chunks), { lastModified: entry.lastModified }) },
      }
    },
    async removeEntry(id) { files.delete(id) },
    async *values() { for (const id of files.keys()) yield await this.getFileHandle(id) },
  }
  return { files, root: { async getDirectoryHandle() { return folder } } }
}

test('private-storage writer returns a disk-backed file and can be discarded', async () => {
  const { files, root } = fakeRoot()
  let received
  const writer = await opfsWriter(root, 'photo.jpg', file => { received = file })
  await writer.write(new Uint8Array([1, 2, 3]))
  await writer.write(new Uint8Array([4]))
  await writer.close()
  assert.equal(received.name, 'photo.jpg')
  assert.deepEqual(new Uint8Array(await received.blob.arrayBuffer()), new Uint8Array([1, 2, 3, 4]))
  assert.equal(files.size, 1)
  await received.discard()
  assert.equal(files.size, 0)
})

test('aborting a private-storage write removes the partial file', async () => {
  const { files, root } = fakeRoot()
  const writer = await opfsWriter(root, 'x.bin', () => assert.fail('no file expected'))
  await writer.write(new Uint8Array(5))
  await writer.abort()
  assert.equal(files.size, 0)
})

test('only temp files older than an hour are cleaned up', async () => {
  const { files, root } = fakeRoot()
  files.set('old', { chunks: [], lastModified: 1_000 })
  files.set('new', { chunks: [], lastModified: 10_000_000 })
  await clearStaleReceived(root, 10_000_000 + 1000)
  assert.deepEqual([...files.keys()], ['new'])
  await clearStaleReceived(root, 1_000 + 3_600_001)
  assert.deepEqual([...files.keys()], ['new'])
})
