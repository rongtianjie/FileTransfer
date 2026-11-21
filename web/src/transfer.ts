export const MAX_FILE = 2 ** 31
export const CHUNK = 32 * 1024
export const WINDOW = 1024 * 1024
const BUFFER = 256 * 1024
const HEADER = 4
const TIMEOUT = 60_000

export interface DiskWriter {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

type Phase = 'idle' | 'waiting' | 'offered' | 'picking' | 'sending' | 'receiving' | 'saving' | 'confirming' | 'done' | 'stopped'
type View = { phase: Phase; name: string; size: number; bytes: number; sent: number; message: string }
type Control =
  | { type: 'offer'; id: number; name: string; size: number }
  | { type: 'accept' | 'finish' | 'complete'; id: number }
  | { type: 'cancel'; id: number; message: string }
  | { type: 'ack'; id: number; bytes: number }
  | { type: 'upgrade'; bytes: number }

type Outgoing = { direction: 'out'; id: number; file: File; sent: number; written: number; accepted: boolean; finished: boolean }
type Incoming = {
  direction: 'in'; id: number; name: string; size: number; queued: number; written: number
  writer?: DiskWriter; writes: Promise<void>; finished: boolean
}

const validSize = (size: unknown): size is number =>
  typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE

const emptyView: View = { phase: 'idle', name: '', bytes: 0, sent: 0, size: 0, message: '' }

export class Transfer {
  view: View = { ...emptyView }
  retryFile?: File
  upgradeBytes?: number
  private active?: Outgoing | Incoming
  private nextId: number
  private lastOffer = 0
  private pumping = false
  private disposed = false
  private timer?: ReturnType<typeof setTimeout>

  private channel: RTCDataChannel
  private host: boolean
  private changed: () => void
  private budget: () => number | undefined
  private upgrade: (size: number) => void

  constructor(
    channel: RTCDataChannel,
    host: boolean,
    changed: () => void,
    budget: () => number | undefined,
    upgrade: (size: number) => void,
  ) {
    this.channel = channel
    this.host = host
    this.changed = changed
    this.budget = budget
    this.upgrade = upgrade
    this.nextId = host ? 1 : 2
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = BUFFER / 2
    channel.onbufferedamountlow = () => void this.pump()
    channel.onmessage = ({ data }) => this.receive(data)
  }

  offer(file: File): boolean {
    if (this.active || this.disposed) return false
    if (!validSize(file.size)) {
      this.update({ ...emptyView, phase: 'stopped', message: '单个文件不能超过 2 GiB。' })
      return false
    }
    this.retryFile = file
    if (this.insufficient(file.size)) {
      this.update({ ...emptyView, phase: 'stopped', name: file.name, size: file.size, message: '中继余量不足，提升额度后可重发。' })
      this.markUpgrade(file.size)
      return false
    }
    const id = this.nextId
    this.nextId += 2
    this.active = { direction: 'out', id, file, sent: 0, written: 0, accepted: false, finished: false }
    this.update({ ...emptyView, phase: 'waiting', name: file.name, size: file.size })
    this.send({ type: 'offer', id, name: file.name, size: file.size })
    this.arm(180_000)
    return true
  }

  retry() {
    if (this.retryFile) this.offer(this.retryFile)
  }

  requestUpgrade() {
    if (this.upgradeBytes !== undefined) this.send({ type: 'upgrade', bytes: this.upgradeBytes })
  }

  checkBudget() {
    const active = this.active
    // While streaming, TURN may already have counted bytes that are still awaiting disk ACK.
    // Check offers before sending; the session server enforces the live relay quota.
    if (!active || (active.direction === 'out' ? active.accepted : active.writer)) return
    const size = active.direction === 'out' ? active.file.size : active.size
    if (this.insufficient(size)) {
      this.markUpgrade(size)
      this.stop('中继余量不足，提升额度后可重发。', true)
    }
  }

  async accept(openWriter: () => Promise<DiskWriter>) {
    const incoming = this.active
    if (incoming?.direction !== 'in' || this.view.phase !== 'offered') return
    this.checkBudget()
    if (this.active !== incoming) return
    this.update({ phase: 'picking' })
    let writer: DiskWriter
    try {
      writer = await openWriter()
    } catch (error) {
      if (this.active !== incoming) return
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.update({ phase: 'offered' })
      } else {
        this.stop('无法打开保存位置，请重新发送后再试。', true)
      }
      return
    }
    if (this.active !== incoming) {
      await writer.abort().catch(() => {})
      return
    }
    incoming.writer = writer
    this.update({ phase: 'receiving' })
    this.send({ type: 'accept', id: incoming.id })
    this.arm()
  }

  cancel() {
    if (this.view.phase !== 'saving' && this.view.phase !== 'confirming') this.stop('已取消传输。', true)
  }

  dispose() {
    this.disposed = true
    this.stop('连接已断开。', false)
    this.channel.onmessage = null
    this.channel.onbufferedamountlow = null
  }

  private update(view: Partial<View>) {
    this.view = { ...this.view, ...view }
    if (!this.disposed) this.changed()
  }

  private arm(delay = TIMEOUT) {
    clearTimeout(this.timer)
    if (this.active) this.timer = setTimeout(() => this.stop('传输等待超时，可重新发送。', true), delay)
  }

  private insufficient(bytes: number) {
    const remaining = this.budget()
    return remaining !== undefined && remaining < bytes
  }

  private markUpgrade(bytes: number) {
    this.upgradeBytes = bytes
    this.upgrade(bytes)
  }

  private send(message: Control) {
    try {
      this.channel.send(JSON.stringify(message))
    } catch {
      this.stop('连接不可用，可重新发送。', false)
    }
  }

  private stop(message: string, notify: boolean) {
    const active = this.active
    if (!active) return
    this.active = undefined
    clearTimeout(this.timer)
    if (active.direction === 'in' && active.writer && this.view.phase !== 'saving') {
      void active.writer.abort().catch(() => {})
    }
    this.update({ phase: 'stopped', message })
    if (notify) this.send({ type: 'cancel', id: active.id, message })
  }

  private complete() {
    const active = this.active
    if (active?.direction === 'out' && active.file === this.retryFile) this.retryFile = undefined
    this.active = undefined
    clearTimeout(this.timer)
    this.update({ phase: 'done' })
  }

  private receive(data: unknown) {
    if (this.disposed) return
    if (data instanceof ArrayBuffer) {
      this.receiveChunk(data)
      return
    }
    if (typeof data !== 'string' || data.length > 8192) return
    let raw: unknown
    try { raw = JSON.parse(data) } catch { return }
    if (!raw || typeof raw !== 'object') return
    const msg = raw as Control
    if (msg.type === 'upgrade') {
      if (validSize(msg.bytes) && msg.bytes > 0) this.markUpgrade(msg.bytes)
      return
    }
    if (!Number.isSafeInteger(msg.id) || msg.id <= 0 || msg.id > 0xffffffff) return
    if (msg.type === 'offer') {
      this.receiveOffer(msg)
      return
    }
    const active = this.active
    if (active?.id !== msg.id) return
    if (msg.type === 'cancel') {
      if (this.view.phase !== 'saving') this.stop('对方已停止传输，可重新发送。', false)
    } else if (active.direction === 'out') {
      this.receiveSenderControl(active, msg)
    } else if (msg.type === 'finish' && active.writer && !active.finished) {
      if (active.queued !== active.size) {
        this.stop('收到的文件不完整，可重新发送。', true)
        return
      }
      active.finished = true
      void this.finish(active, active.writer)
    }
  }

  private receiveOffer(msg: Extract<Control, {type: 'offer'}>) {
    if (msg.id % 2 === (this.host ? 1 : 0) || msg.id <= this.lastOffer) return
    this.lastOffer = msg.id
    if (!validSize(msg.size) || typeof msg.name !== 'string' || !msg.name || msg.name.length > 1024) {
      this.send({ type: 'cancel', id: msg.id, message: '文件信息无效。' })
      return
    }
    if (this.active) {
      const simultaneous = this.active.direction === 'out' && !this.active.accepted
      if (!simultaneous || this.host) {
        this.send({ type: 'cancel', id: msg.id, message: '对方正忙。' })
        return
      }
      this.stop('双方同时发送，本轮先接收发起方的文件。', true)
    }
    if (this.insufficient(msg.size)) {
      this.markUpgrade(msg.size)
      this.send({ type: 'upgrade', bytes: msg.size })
      this.send({ type: 'cancel', id: msg.id, message: '中继余量不足。' })
      return
    }
    this.active = { direction: 'in', id: msg.id, name: msg.name, size: msg.size, queued: 0, written: 0, writes: Promise.resolve(), finished: false }
    this.update({ ...emptyView, phase: 'offered', name: msg.name, size: msg.size })
    this.arm(180_000)
  }

  private receiveSenderControl(active: Outgoing, msg: Control) {
    if (msg.type === 'accept' && !active.accepted) {
      active.accepted = true
      this.update({ phase: 'sending' })
      this.arm()
      void this.pump()
    } else if (msg.type === 'ack' && active.accepted) {
      if (!Number.isSafeInteger(msg.bytes) || msg.bytes <= active.written || msg.bytes > active.sent ||
        (msg.bytes !== active.file.size && msg.bytes % CHUNK !== 0)) return
      active.written = msg.bytes
      this.update({ bytes: msg.bytes })
      this.arm()
      void this.pump()
    } else if (msg.type === 'complete' && active.finished && active.written === active.file.size) {
      this.complete()
    }
  }

  private async pump() {
    const active = this.active
    if (this.pumping || active?.direction !== 'out' || !active.accepted || active.finished) return
    this.pumping = true
    try {
      while (this.active === active && active.sent < active.file.size && this.channel.bufferedAmount < BUFFER) {
        const size = Math.min(CHUNK, active.file.size - active.sent, WINDOW - (active.sent - active.written))
        if (size <= 0) break
        const slice = await active.file.slice(active.sent, active.sent + size).arrayBuffer()
        if (this.active !== active) return
        const frame = new ArrayBuffer(HEADER + slice.byteLength)
        new DataView(frame).setUint32(0, active.id)
        new Uint8Array(frame, HEADER).set(new Uint8Array(slice))
        this.channel.send(frame)
        active.sent += size
        this.view.sent = active.sent
      }
      if (this.active === active && active.written === active.file.size) {
        active.finished = true
        this.update({ phase: 'confirming' })
        this.send({ type: 'finish', id: active.id })
      }
    } catch {
      if (this.active === active) this.stop('读取或发送文件失败，可重新发送。', true)
    } finally {
      this.pumping = false
      if (this.active !== active) void this.pump()
    }
  }

  private receiveChunk(frame: ArrayBuffer) {
    const incoming = this.active
    if (incoming?.direction !== 'in' || frame.byteLength < HEADER) return
    if (new DataView(frame).getUint32(0) !== incoming.id) return
    const writer = incoming.writer
    const size = frame.byteLength - HEADER
    if (!writer || incoming.finished || size < 1 || size !== Math.min(CHUNK, incoming.size - incoming.queued) ||
      incoming.queued - incoming.written + size > WINDOW) {
      this.stop('文件数据超出接收范围，已停止传输。', true)
      return
    }
    incoming.queued += size
    incoming.writes = incoming.writes.then(async () => {
      if (this.active !== incoming) return
      await writer.write(new Uint8Array(frame, HEADER))
      if (this.active !== incoming) return
      incoming.written += size
      this.send({ type: 'ack', id: incoming.id, bytes: incoming.written })
      if (this.active !== incoming) return
      this.update({ bytes: incoming.written })
      this.arm()
    }).catch(() => {
      if (this.active === incoming) this.stop('写入文件失败，请检查保存位置后重试。', true)
    })
  }

  private async finish(incoming: Incoming, writer: DiskWriter) {
    try {
      await incoming.writes
      if (this.active !== incoming) return
      clearTimeout(this.timer)
      this.update({ phase: 'saving' })
      await writer.close()
      if (this.active !== incoming) return
      this.send({ type: 'complete', id: incoming.id })
      if (this.active === incoming) this.complete()
    } catch {
      if (this.active === incoming) this.stop('保存文件失败，请重新发送。', true)
    }
  }
}
