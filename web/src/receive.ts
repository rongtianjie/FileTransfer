import type { DiskWriter } from './transfer.ts'

// 'picker': stream straight to a user-chosen file (desktop Chromium).
// 'opfs': stream into the browser's private storage, then the user saves it (Android Chrome, newer Safari).
// 'memory': last resort for browsers with neither; capped because the data lives in RAM.
export type ReceiveMode = 'picker' | 'opfs' | 'memory'

export const MEMORY_LIMIT = 256 * 1024 * 1024
const OPFS_MARGIN = 64 * 1024 * 1024
const BLOCK = 4 * 1024 * 1024
const STALE_MS = 60 * 60 * 1000
const FOLDER = 'incoming'

export interface Received {
  name: string
  size: number
  blob: Blob
  discard(): Promise<void>
}

export function detectReceiveMode(env: { picker: boolean; opfs: boolean }): ReceiveMode {
  return env.picker ? 'picker' : env.opfs ? 'opfs' : 'memory'
}

// Largest file this device can take right now, or Infinity when the browser cannot say.
export function receiveLimit(mode: ReceiveMode, estimate?: { quota?: number; usage?: number }) {
  if (mode === 'memory') return MEMORY_LIMIT
  if (mode === 'picker' || estimate?.quota === undefined) return Infinity
  return Math.max(0, estimate.quota - (estimate.usage ?? 0) - OPFS_MARGIN)
}

// Blobs are reference-counted and browsers may keep large ones on disk, so merge in blocks
// instead of holding thousands of small chunks.
export function memoryWriter(name: string, done: (file: Received) => void): DiskWriter {
  let blocks: Blob[] = []
  let parts: Uint8Array<ArrayBuffer>[] = []
  let pending = 0
  let size = 0
  const flush = () => {
    if (!parts.length) return
    blocks.push(new Blob(parts))
    parts = []
    pending = 0
  }
  return {
    async write(bytes) {
      parts.push(bytes)
      pending += bytes.byteLength
      size += bytes.byteLength
      if (pending >= BLOCK) flush()
    },
    async close() {
      flush()
      done({ name, size, blob: new Blob(blocks), discard: async () => {} })
    },
    async abort() {
      blocks = []
      parts = []
    },
  }
}

export async function opfsWriter(root: FileSystemDirectoryHandle, name: string, done: (file: Received) => void): Promise<DiskWriter> {
  const folder = await root.getDirectoryHandle(FOLDER, { create: true })
  const id = crypto.randomUUID()
  const handle = await folder.getFileHandle(id, { create: true })
  const stream = await handle.createWritable()
  const discard = () => folder.removeEntry(id).catch(() => {})
  return {
    write: bytes => stream.write(bytes),
    async close() {
      await stream.close()
      const file = await handle.getFile()
      done({ name, size: file.size, blob: file, discard })
    },
    async abort() {
      await stream.abort().catch(() => {})
      await discard()
    },
  }
}

// Temp files from a closed tab would otherwise stay in the user's storage forever.
export async function clearStaleReceived(root: FileSystemDirectoryHandle, now = Date.now()) {
  try {
    const folder = await root.getDirectoryHandle(FOLDER)
    // Async iteration of directory handles is missing from the bundled DOM typings.
    const entries = (folder as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()
    for await (const entry of entries) {
      if (entry.kind !== 'file') continue
      const file = await (entry as FileSystemFileHandle).getFile()
      if (now - file.lastModified > STALE_MS) await folder.removeEntry(entry.name).catch(() => {})
    }
  } catch {
    // No folder yet, or storage unavailable: nothing to clean.
  }
}

// Must run inside a user gesture on some browsers, hence the explicit save button.
export function saveToDevice(file: Received) {
  const url = URL.createObjectURL(file.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
