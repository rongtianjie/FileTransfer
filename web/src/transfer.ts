export const MAX_FILE = 2 ** 31
export const CHUNK = 32 * 1024
export const WINDOW = 1024 * 1024
const BUFFER = 256 * 1024
const HEADER = 4
const TIMEOUT = 60_000
export const MAX_BATCH = 200

export interface DiskWriter {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

type Phase = 'idle' | 'waiting' | 'offered' | 'picking' | 'sending' | 'receiving' | 'saving' | 'confirming' | 'unconfirmed' | 'done' | 'stopped'
type View = {
  phase: Phase; name: string; size: number; bytes: number; sent: number; message: string
  batchIndex?: number; batchTotal?: number
}
type BatchInfo = { id: number; index: number; count: number }
export type OpenBatchFile = (name: string) => Promise<DiskWriter>
export type RelaySwitch = { type: 'relay-prepare' | 'relay-ready' | 'relay-busy' | 'relay-release'; id: number }
type CancelReason = 'cancelled' | 'busy' | 'quota' | 'invalid' | 'timeout' | 'failed' | 'save_failed' | 'unsupported' | 'too_large'

type Control = RelaySwitch
  | { type: 'offer'; id: number; name: string; size: number; batch?: BatchInfo }
  | { type: 'accept' | 'finish' | 'complete'; id: number }
  | { type: 'cancel'; id: number; reason?: CancelReason; message?: string }
  | { type: 'ack'; id: number; bytes: number }
  | { type: 'upgrade'; bytes: number }

type Outgoing = { direction: 'out'; id: number; file: File; sent: number; written: number; accepted: boolean; finished: boolean }
type Incoming = {
  direction: 'in'; id: number; name: string; size: number; queued: number; written: number
  writer?: DiskWriter; writes: Promise<void>; finished: boolean; batch?: BatchInfo
}

const validSize = (size: unknown, max = MAX_FILE): size is number =>
  typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= max

const insufficientMessage = '当前中继余量不足以传输此文件。'
const fileLimitMessage = '单个文件不能超过 2 GiB。'
const uncertainMessage = '连接已断开，无法确认对方是否已保存文件。请先向对方确认。'

const saveFailureMessage = '保存文件失败，请重新发送。'

function peerCancelMessage({ reason, message }: Extract<Control, { type: 'cancel' }>) {
  switch (reason) {
    case 'busy': return '对方正忙，请稍后重试。'
    case 'quota': return insufficientMessage
    case 'timeout': return '对方等待超时，可重新发送。'
    case 'save_failed': return '对方保存文件失败，可重新发送。'
    case 'unsupported': return '对方的浏览器只能发送文件，无法接收。'
    case 'too_large': return '文件超出对方设备可接收的大小，请改用电脑接收或发送较小的文件。'
    case 'cancelled':
    case 'invalid':
    case 'failed': return '对方已停止传输，可重新发送。'
  }
  // Older tabs sent fixed text. Recognize only known outcomes.
  switch (message) {
    case saveFailureMessage: return '对方保存文件失败，可重新发送。'
    case '已取消传输。':
    case '收到的文件不完整，可重新发送。':
    case '写入文件失败，请检查保存位置后重试。':
    case '传输等待超时，可重新发送。': return '对方已停止传输，可重新发送。'
  }
}

function validBatch(batch: unknown): BatchInfo | undefined {
  if (!batch || typeof batch !== 'object') return undefined
  const { id, index, count } = batch as Record<string, unknown>
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  return whole(id) && whole(index) && whole(count) && id > 0 && count >= 2 && count <= MAX_BATCH && index >= 1 && index <= count
    ? { id, index, count } : undefined
}

// update() merges, so batch fields must be cleared explicitly.
const emptyView: View = { phase: 'idle', name: '', bytes: 0, sent: 0, size: 0, message: '', batchIndex: undefined, batchTotal: undefined }

export class Transfer {
  view: View = { ...emptyView }
  retryFile?: File
  // Files of an interrupted batch that still need sending, current one first.
  private retryQueue?: File[]

  get retryFiles(): File[] {
    return this.retryQueue ?? (this.retryFile ? [this.retryFile] : [])
  }

  // A reconnect builds a new Transfer, so the owner hands the unsent files back.
  set retryFiles(files: File[]) {
    this.retryFile = files[0]
    this.retryQueue = files.length > 1 ? files : undefined
  }
  upgradeBytes?: number
  unreportedSave?: { name: string; saved: boolean }
  // Browsers without a streaming save API can still send; they refuse incoming offers.
  canReceive = true
  // Largest file this device can take right now (memory or storage bound); re-read per offer.
  receiveLimit: () => number = () => Infinity
  private active?: Outgoing | Incoming
  // Sender: files still to offer after the current one. Receiver: where to save the rest.
  private outBatch?: { id: number; total: number; index: number; rest: File[] }
  private inBatch?: { id: number; open: OpenBatchFile }
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
  private available: (incoming: boolean) => boolean
  private relaySwitch: (message: RelaySwitch) => void
  private unlimited: () => boolean

  constructor(
    channel: RTCDataChannel,
    host: boolean,
    changed: () => void,
    budget: () => number | undefined,
    upgrade: (size: number) => void,
    available: (incoming: boolean) => boolean = () => true,
    relaySwitch: (message: RelaySwitch) => void = () => {},
    unlimited: () => boolean = () => false,
  ) {
    this.channel = channel
    this.host = host
    this.changed = changed
    this.budget = budget
    this.upgrade = upgrade
    this.available = available
    this.relaySwitch = relaySwitch
    this.unlimited = unlimited
    this.nextId = host ? 1 : 2
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = BUFFER / 2
    channel.onbufferedamountlow = () => void this.pump()
    channel.onmessage = ({ data }) => this.receive(data)
  }

  get inProgress() {
    return this.active !== undefined
  }

  get canOffer() {
    return !this.inProgress && !this.disposed && this.available(false)
  }

  private get maxFileSize() {
    return this.unlimited() ? Number.MAX_SAFE_INTEGER : MAX_FILE
  }

  offer(file: File): boolean {
    return this.offerFiles([file])
  }

  // Files go one at a time through the normal offer flow; a batch only adds progress context
  // and lets the receiver save the rest into one folder without prompting again.
  offerFiles(files: File[]): boolean {
    if (!this.canOffer || !files.length) return false
    if (files.length > MAX_BATCH) {
      this.update({ ...emptyView, phase: 'stopped', message: `一次最多发送 ${MAX_BATCH} 个文件。` })
      return false
    }
    if (!files.every(file => validSize(file.size, this.maxFileSize))) {
      this.update({ ...emptyView, phase: 'stopped', message: this.unlimited() ? '文件大小无效。' : fileLimitMessage })
      return false
    }
    this.retryQueue = undefined
    const [first, ...rest] = files
    this.outBatch = rest.length ? { id: this.nextId, total: files.length, index: 1, rest } : undefined
    const started = this.begin(first)
    if (!started) {
      this.outBatch = undefined
      if (files.length > 1) this.retryQueue = files
    }
    return started
  }

  private begin(file: File): boolean {
    this.retryFile = file
    if (this.insufficient(file.size)) {
      this.update({ ...emptyView, phase: 'stopped', name: file.name, size: file.size, message: insufficientMessage })
      this.markUpgrade(file.size)
      return false
    }
    const id = this.nextId
    this.nextId += 2
    const batch = this.outBatch && { id: this.outBatch.id, index: this.outBatch.index, count: this.outBatch.total }
    this.active = { direction: 'out', id, file, sent: 0, written: 0, accepted: false, finished: false }
    this.update({
      ...emptyView, phase: 'waiting', name: file.name, size: file.size,
      ...(batch && { batchIndex: batch.index, batchTotal: batch.count }),
    })
    this.send({ type: 'offer', id, name: file.name, size: file.size, ...(batch && { batch }) })
    this.arm(180_000)
    return true
  }

  private advance() {
    const batch = this.outBatch
    if (!batch) return
    const next = batch.rest.shift()
    if (!next) {
      this.outBatch = undefined
      this.update({ message: `已发送 ${batch.total} 个文件。` })
      return
    }
    batch.index++
    // A failed offer (for example relay credit) leaves the stopped view that begin() set.
    if (!this.begin(next)) {
      this.retryQueue = [next, ...batch.rest]
      this.outBatch = undefined
    }
  }

  retry() {
    const files = this.retryFiles
    if (files.length) this.offerFiles(files)
  }

  requestUpgrade() {
    return this.canOffer && this.upgradeBytes !== undefined &&
      this.sendControl({ type: 'upgrade', bytes: this.upgradeBytes })
  }

  sendRelaySwitch(message: RelaySwitch) {
    return this.sendControl(message)
  }

  checkBudget() {
    const active = this.active
    // While streaming, TURN may already have counted bytes that are still awaiting disk ACK.
    // Check offers before sending; the session server enforces the live relay quota.
    if (!active) return
    const size = active.direction === 'out' ? active.file.size : active.size
    if (size > this.maxFileSize && this.view.phase !== 'saving' && this.view.phase !== 'confirming') {
      this.stop(fileLimitMessage, 'invalid')
      return
    }
    if (active.direction === 'out' ? active.accepted : active.writer) return
    if (this.insufficient(size)) {
      this.markUpgrade(size)
      this.stop(insufficientMessage, 'quota')
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
        this.stop('无法打开保存位置，请重新发送后再试。', 'failed')
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

  // Accepts this file and every later file of its batch into the same place.
  async acceptBatch(open: OpenBatchFile) {
    const incoming = this.active
    if (incoming?.direction !== 'in' || !incoming.batch) return
    await this.accept(() => open(incoming.name))
    if (this.active === incoming && incoming.writer) this.inBatch = { id: incoming.batch.id, open }
  }

  cancel() {
    if (this.view.phase !== 'saving' && this.view.phase !== 'confirming') this.stop('已取消传输。', 'cancelled')
  }

  dispose() {
    this.disposed = true
    if (this.view.phase === 'confirming') this.unconfirmed()
    else if (this.view.phase !== 'saving') this.stop('连接已断开。')
    this.channel.onmessage = null
    this.channel.onbufferedamountlow = null
  }

  private update(view: Partial<View>) {
    this.view = { ...this.view, ...view }
    this.changed()
  }

  private arm(delay = TIMEOUT) {
    clearTimeout(this.timer)
    if (this.active) this.timer = setTimeout(() => this.stop('传输等待超时，可重新发送。', 'timeout'), delay)
  }

  private insufficient(bytes: number) {
    const remaining = this.budget()
    return remaining !== undefined && remaining < bytes
  }

  private markUpgrade(bytes: number) {
    this.upgradeBytes = bytes
    this.upgrade(bytes)
  }

  private sendControl(message: Control): boolean {
    if (this.disposed) return false
    try {
      this.channel.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private send(message: Control) {
    if (this.sendControl(message)) return
    if (this.view.phase === 'confirming') this.unconfirmed()
    else this.stop('连接不可用，可重新发送。')
  }

  private stop(message: string, reason?: CancelReason) {
    const active = this.active
    if (!active || this.view.phase === 'saving') return
    this.active = undefined
    clearTimeout(this.timer)
    if (active.direction === 'in') this.inBatch = undefined
    const batch = this.outBatch
    this.outBatch = undefined
    if (batch && active.direction === 'out') this.retryQueue = [active.file, ...batch.rest]
    if (active.direction === 'in' && active.writer) {
      void active.writer.abort().catch(() => {})
    }
    this.update({ phase: 'stopped', message: batch ? `${message} 已完成 ${batch.index - 1} / ${batch.total} 个文件。` : message })
    if (reason) this.sendControl({ type: 'cancel', id: active.id, reason })
  }

  private unconfirmed() {
    this.settle('unconfirmed', uncertainMessage)
  }

  private settle(phase: 'done' | 'unconfirmed' | 'stopped', message = '') {
    const active = this.active
    if (active?.direction === 'out' && active.file === this.retryFile) {
      this.retryFile = undefined
      this.retryQueue = undefined
    }
    this.active = undefined
    clearTimeout(this.timer)
    if (phase !== 'done') {
      this.outBatch = undefined
      this.inBatch = undefined
    }
    this.update({ phase, message })
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
    if (msg.type === 'relay-prepare' || msg.type === 'relay-ready' || msg.type === 'relay-busy' || msg.type === 'relay-release') {
      this.relaySwitch(msg)
      return
    }
    if (msg.type === 'offer') {
      this.receiveOffer(msg)
      return
    }
    const active = this.active
    if (active?.id !== msg.id) return
    if (msg.type === 'cancel') {
      // A known receiver cancellation is terminal. The receiver cannot cancel during close.
      const message = peerCancelMessage(msg)
      if (this.view.phase === 'confirming' && !message) return
      this.stop(message ?? '对方已停止传输，可重新发送。')
    } else if (active.direction === 'out') {
      this.receiveSenderControl(active, msg)
    } else if (msg.type === 'finish' && active.writer && !active.finished) {
      if (active.queued !== active.size) {
        this.stop('收到的文件不完整，可重新发送。', 'invalid')
        return
      }
      active.finished = true
      void this.finish(active, active.writer)
    }
  }

  private receiveOffer(msg: Extract<Control, {type: 'offer'}>) {
    if (msg.id % 2 === (this.host ? 1 : 0) || msg.id <= this.lastOffer) return
    this.lastOffer = msg.id
    if (!validSize(msg.size, this.maxFileSize) || typeof msg.name !== 'string' || !msg.name || msg.name.length > 1024) {
      this.send({ type: 'cancel', id: msg.id, reason: 'invalid' })
      return
    }
    if (!this.canReceive) {
      this.sendControl({ type: 'cancel', id: msg.id, reason: 'unsupported' })
      return
    }
    if (msg.size > this.receiveLimit()) {
      this.sendControl({ type: 'cancel', id: msg.id, reason: 'too_large' })
      return
    }
    if (!this.available(true)) {
      this.sendControl({ type: 'cancel', id: msg.id, reason: 'busy' })
      return
    }
    if (this.active) {
      const simultaneous = this.active.direction === 'out' && !this.active.accepted
      if (!simultaneous || this.host) {
        this.sendControl({ type: 'cancel', id: msg.id, reason: 'busy' })
        return
      }
      this.stop('双方同时发送，本轮先接收发起方的文件。', 'busy')
    }
    if (this.insufficient(msg.size)) {
      this.markUpgrade(msg.size)
      this.send({ type: 'upgrade', bytes: msg.size })
      this.sendControl({ type: 'cancel', id: msg.id, reason: 'quota' })
      return
    }
    const batch = validBatch(msg.batch)
    const sink = batch && this.inBatch?.id === batch.id ? this.inBatch : undefined
    if (!sink) this.inBatch = undefined
    const incoming: Incoming = {
      direction: 'in', id: msg.id, name: msg.name, size: msg.size, queued: 0, written: 0,
      writes: Promise.resolve(), finished: false, batch,
    }
    this.active = incoming
    this.update({
      ...emptyView, phase: 'offered', name: msg.name, size: msg.size,
      ...(batch && { batchIndex: batch.index, batchTotal: batch.count }),
    })
    this.arm(180_000)
    if (sink && batch) {
      // The receiver already chose a folder for this batch.
      if (batch.index === batch.count) this.inBatch = undefined
      void this.accept(() => sink.open(msg.name))
    }
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
      this.settle('done')
      this.advance()
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
        clearTimeout(this.timer)
        if (this.active === active) {
          this.timer = setTimeout(() => this.update({ message: '仍在等待对方确认保存。确认前无法开始新的传输。' }), TIMEOUT)
        }
      }
    } catch {
      if (this.active === active) this.stop('读取或发送文件失败，可重新发送。', 'failed')
    } finally {
      this.pumping = false
      if (this.active !== active) void this.pump()
    }
  }

  private receiveChunk(frame: ArrayBuffer) {
    const incoming = this.active
    if (incoming?.direction !== 'in' || incoming.finished || frame.byteLength < HEADER) return
    if (new DataView(frame).getUint32(0) !== incoming.id) return
    const writer = incoming.writer
    const size = frame.byteLength - HEADER
    if (!writer || size < 1 || size !== Math.min(CHUNK, incoming.size - incoming.queued) ||
      incoming.queued - incoming.written + size > WINDOW) {
      this.stop('文件数据超出接收范围，已停止传输。', 'invalid')
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
      if (this.active === incoming) this.stop('写入文件失败，请检查保存位置后重试。', 'failed')
    })
  }

  private async finish(incoming: Incoming, writer: DiskWriter) {
    await incoming.writes
    if (this.active !== incoming) return
    clearTimeout(this.timer)
    this.update({ phase: 'saving' })
    let saved = true
    try {
      await writer.close()
    } catch {
      saved = false
    }
    if (this.active !== incoming) return
    const reported = this.sendControl(saved
      ? { type: 'complete', id: incoming.id }
      : { type: 'cancel', id: incoming.id, reason: 'save_failed' })
    const disconnect = !reported && !this.disposed
    if (disconnect) this.unreportedSave = { name: incoming.name, saved }
    const last = incoming.batch && incoming.batch.index === incoming.batch.count
    this.settle(saved ? 'done' : 'stopped', saved ? (last ? `已接收 ${incoming.batch!.count} 个文件。` : '') : saveFailureMessage)
    if (disconnect) this.channel.close()
  }
}
