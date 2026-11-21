import { MAX_FILE, Transfer, type RelaySwitch } from './transfer.ts'

type Epoch = number | string
type Mode = 'direct' | 'relay'
type Signal = RTCSessionDescriptionInit | RTCIceCandidateInit
type Start = {
  type: 'start'; epoch: Epoch; initiator: boolean; mode: Mode; iceServers?: RTCIceServer[]
  remaining?: number; authorized?: boolean; unlimited?: boolean
}
type ServerMessage = Start
  | { type: 'created'; code: string; token: string; expiresAt: number }
  | { type: 'joined'; token: string }
  | { type: 'request'; requestId: string }
  | { type: 'waiting' }
  | { type: 'config'; relayAvailable: boolean; keyAvailable: boolean; adminProof?: string }
  | { type: 'balance'; remaining: number; authorized: boolean; unlimited?: boolean }
  | { type: 'signal'; epoch: Epoch; data: Signal }
  | { type: 'failed'; epoch: Epoch; mode: Mode; message?: string; reason?: string }
  | { type: 'closed' | 'error'; message?: string; reason?: string }

type Transition =
  | { type: 'retry' }
  | { type: 'relay'; key?: string }
  | { type: 'relay_upgrade'; key: string; epoch: Epoch }

type Upgrade =
  | { phase: 'preparing'; id: number; key: string; timer: ReturnType<typeof setTimeout> }
  | { phase: 'submitted' | 'reserved'; id: number }

type Attempt = {
  epoch: Epoch; mode: Mode; pc: RTCPeerConnection; channel?: RTCDataChannel
  timer?: ReturnType<typeof setTimeout>; pathCheck?: ReturnType<typeof setInterval>
  upgrade?: Upgrade
  signaling: Promise<void>; candidates: RTCIceCandidateInit[]; ready: boolean; checking: boolean
}

const messages: Record<string, string> = {
  session_quota: '本房间的免费中继额度不足。',
  global_quota: '公共中继额度已用尽。',
  relay_expired: '本轮中继已到期。',
  connection_failed: '设备之间的连接未能建立或已断开。',
  invalid_key: '中继密钥无效，请检查后再试。',
}

export function iceConfig(mode: Mode, servers: RTCIceServer[]): RTCConfiguration {
  const iceServers = servers.flatMap(server => {
    const urls = (typeof server.urls === 'string' ? [server.urls] : server.urls).filter(url =>
      mode === 'relay' ? /^turns?:/i.test(url) : /^stuns?:/i.test(url))
    if (!urls.length) return []
    return [mode === 'relay' ? { ...server, urls } : { urls }]
  })
  return { iceServers, iceTransportPolicy: mode === 'relay' ? 'relay' : 'all' }
}

export async function usesRelay(pc: RTCPeerConnection): Promise<boolean> {
  const ice = pc.sctp?.transport.iceTransport
  const pair = ice?.getSelectedCandidatePair?.()
  if (pair?.local.type) return pair.local.type === 'relay'

  const stats = await pc.getStats()
  for (const report of stats.values()) {
    if (report.type !== 'transport' || !report.selectedCandidatePairId) continue
    const pair = stats.get(report.selectedCandidatePairId)
    if (pair?.state === 'succeeded' && stats.get(pair.localCandidateId)?.candidateType === 'relay') return true
  }
  return false
}

export class Session {
  socketState: 'connecting' | 'open' | 'offline' = 'offline'
  phase: 'idle' | 'lobby' | 'connecting' | 'connected' | 'failed' = 'idle'
  role?: 'host' | 'guest'
  code = ''
  expiresAt?: number
  requestId?: string
  busy = false
  mode?: Mode
  message = ''
  relayAvailable = false
  keyAvailable = false
  remaining?: number
  authorized = false
  unlimited = false
  adminProof?: string
  upgradeBytes?: number
  retryFile?: File
  unconfirmedSave?: { name: string; message: string }
  detachedSave?: { name: string; saved: boolean }
  transfer?: Transfer

  private socket?: WebSocket
  private token?: string
  private attempt?: Attempt
  private nextUpgrade = 1
  private finishingSave?: Transfer
  private lastEpoch?: Epoch
  private changed: () => void

  constructor(changed: () => void) {
    this.changed = changed
  }

  connect() {
    if (this.socketState !== 'offline') return
    this.relayAvailable = false
    this.keyAvailable = false
    this.message = ''
    this.socketState = 'connecting'
    const url = new URL('/api/session', location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    this.socket = ws
    ws.onopen = () => {
      if (this.socket !== ws) return
      this.socketState = 'open'
      this.changed()
    }
    ws.onmessage = ({ data }) => {
      if (this.socket !== ws || typeof data !== 'string') return
      let parsed: unknown
      try { parsed = JSON.parse(data) } catch { return }
      if (parsed && typeof parsed === 'object' && 'type' in parsed) this.receive(parsed as ServerMessage)
    }
    ws.onerror = () => ws.close()
    ws.onclose = () => {
      if (this.socket !== ws) return
      this.socket = undefined
      this.adminProof = undefined
      this.socketState = 'offline'
      this.reset('会话服务已断开。请重新连接，再创建或加入房间。')
      this.changed()
    }
    this.changed()
  }

  enter(role: 'host' | 'guest', code: string) {
    if (this.phase !== 'idle' || this.busy || this.socketState !== 'open' || (role === 'guest' && !code)) return
    this.role = role
    this.code = code
    this.busy = true
    this.message = ''
    this.send({ type: role === 'host' ? 'create' : 'join', ...(code && { code }) })
    this.changed()
  }

  answer(accept: boolean, requestId: string | undefined) {
    if (this.role !== 'host' || !requestId || requestId !== this.requestId || this.busy) return
    this.requestId = undefined
    this.busy = accept
    this.message = accept ? '已同意加入，正在协商连接。' : '已拒绝加入申请。'
    this.send({ type: accept ? 'accept' : 'reject', requestId })
    this.changed()
  }

  leave() {
    if (!this.token) return
    this.send({ type: 'leave' })
    this.reset('')
    this.changed()
  }

  retryDirect() {
    if (this.role === 'host' && this.phase === 'failed' && !this.busy) this.transition({ type: 'retry' })
  }

  relay(key?: string) {
    if (this.role !== 'host' || !this.relayAvailable || this.busy) return
    if (this.phase === 'failed') {
      this.transition({ type: 'relay', ...(key && { key }) })
      return
    }
    const { attempt, transfer } = this
    if (!key || !this.canUpgrade || !attempt?.ready || !transfer?.canOffer) return
    const id = this.nextUpgrade++
    const timer = setTimeout(() => {
      if (this.attempt !== attempt || attempt.upgrade?.phase !== 'preparing' || attempt.upgrade.id !== id) return
      this.releaseUpgrade(attempt, '未收到对方的切换确认。若对方仍使用旧页面，请在空闲时刷新后重新加入。')
    }, 8_000)
    attempt.upgrade = { phase: 'preparing', id, key, timer }
    this.busy = true
    this.message = '正在等待对方确认可以切换中继。'
    if (transfer.sendRelaySwitch({ type: 'relay-prepare', id })) this.changed()
    else this.releaseUpgrade(attempt, '无法联系对方确认切换，请稍后重试。', false)
  }

  askForUpgrade() {
    if (this.role !== 'guest' || !this.canUpgrade || !this.transfer?.requestUpgrade()) return
    this.message = '已提醒房主输入中继密钥。'
    this.changed()
  }

  get switchingRelay() {
    return this.attempt?.upgrade !== undefined
  }

  get savingAfterDisconnect() {
    return this.finishingSave !== undefined
  }

  get canUpgrade() {
    return this.mode === 'relay' && this.phase === 'connected' && !this.authorized && !this.unlimited &&
      this.upgradeBytes !== undefined && this.relayAvailable && this.keyAvailable
  }

  private receiveUpgrade(attempt: Attempt, msg: RelaySwitch) {
    if (this.attempt !== attempt || attempt.mode !== 'relay' || !this.transfer) return
    const { upgrade } = attempt
    if (this.role === 'guest') {
      if (msg.type === 'relay-prepare') {
        if (upgrade || !attempt.ready || !this.transfer.canOffer) {
          this.transfer.sendRelaySwitch({ type: 'relay-busy', id: msg.id })
          return
        }
        attempt.upgrade = { phase: 'reserved', id: msg.id }
        if (!this.transfer.sendRelaySwitch({ type: 'relay-ready', id: msg.id })) attempt.upgrade = undefined
        this.changed()
      } else if (msg.type === 'relay-release' && upgrade?.id === msg.id) {
        attempt.upgrade = undefined
        this.changed()
      }
    } else if (upgrade?.phase === 'preparing' && upgrade.id === msg.id) {
      if (msg.type === 'relay-busy' || (msg.type === 'relay-ready' && this.transfer.inProgress)) {
        this.releaseUpgrade(attempt, '对方正在处理文件，请在传输结束后重试。')
      } else if (msg.type === 'relay-ready') {
        if (!this.canUpgrade) {
          this.releaseUpgrade(attempt, '当前无需切换中继额度。')
          return
        }
        clearTimeout(upgrade.timer)
        attempt.upgrade = { phase: 'submitted', id: msg.id }
        this.transition({ type: 'relay_upgrade', key: upgrade.key, epoch: attempt.epoch })
      }
    }
  }

  private releaseUpgrade(attempt: Attempt, message: string, notify = true) {
    const { upgrade } = attempt
    if (!upgrade) return
    if (upgrade.phase === 'preparing') clearTimeout(upgrade.timer)
    if (notify && !this.transfer?.sendRelaySwitch({ type: 'relay-release', id: upgrade.id })) {
      // Keep both peers reserved until channel closure tears down the attempt.
      attempt.channel?.close()
      return
    }
    attempt.upgrade = undefined
    this.busy = false
    this.message = message
    this.changed()
  }

  private transition(message: Transition) {
    this.busy = true
    this.message = '正在等待新的连接配置。'
    if (!this.send(message)) {
      const unavailable = '会话服务不可用，请稍后重试。'
      if (this.attempt?.upgrade?.phase === 'submitted') {
        this.releaseUpgrade(this.attempt, unavailable)
        return
      }
      this.busy = false
      this.message = unavailable
    }
    this.changed()
  }

  private send(message: { type: string; [key: string]: unknown }) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    try {
      if (message.type === 'create' || message.type === 'join') {
        this.socket.send(JSON.stringify(message))
      } else if (this.token) {
        this.socket.send(JSON.stringify({ ...message, token: this.token }))
      } else return false
      return true
    } catch {
      return false
    }
  }

  private receive(msg: ServerMessage) {
    if (msg.type === 'config') {
      this.relayAvailable = msg.relayAvailable === true
      this.keyAvailable = msg.keyAvailable === true
      if (msg.adminProof) this.adminProof = msg.adminProof
    } else if (msg.type === 'created' || msg.type === 'joined') {
      if (!this.busy || this.phase !== 'idle' || this.role !== (msg.type === 'created' ? 'host' : 'guest')) return
      this.token = msg.token
      this.phase = 'lobby'
      this.busy = false
      if (msg.type === 'created') {
        this.code = msg.code
        this.expiresAt = msg.expiresAt
      }
    } else if (msg.type === 'error') {
      const message = (msg.reason && messages[msg.reason]) || msg.message || '会话操作失败，请重试。'
      if (this.attempt?.upgrade?.phase === 'submitted') {
        this.releaseUpgrade(this.attempt, message)
        return
      }
      if (this.attempt?.upgrade?.phase !== 'preparing') this.busy = false
      if (this.phase === 'idle') this.role = undefined
      this.message = message
    } else if (this.token) {
      if (msg.type === 'closed') {
        this.reset(msg.message || '房间已关闭。')
      } else if (msg.type === 'request' && this.role === 'host' && this.phase === 'lobby') {
        if (typeof msg.requestId !== 'string' || !msg.requestId) return
        this.requestId = msg.requestId
        this.busy = false
        this.message = ''
      } else if (msg.type === 'waiting' && this.role === 'host' && this.phase === 'lobby') {
        this.requestId = undefined
        if (this.busy) this.message = ''
        this.busy = false
      } else if (msg.type === 'start') {
        if (msg.epoch === this.lastEpoch ||
          (typeof msg.epoch === 'number' && typeof this.lastEpoch === 'number' && msg.epoch < this.lastEpoch)) return
        this.lastEpoch = msg.epoch
        this.start(msg)
      } else if (msg.type === 'signal' && this.attempt?.epoch === msg.epoch) {
        this.signal(this.attempt, msg.data)
      } else if (msg.type === 'failed' && this.lastEpoch === msg.epoch) {
        this.closeAttempt()
        this.phase = 'failed'
        this.busy = false
        this.mode = msg.mode
        this.message = (msg.reason && messages[msg.reason]) || msg.message || (msg.mode === 'direct' ? '直连未建立。' : '中继连接已中断。')
      } else if (msg.type === 'balance') {
        this.unlimited = msg.unlimited === true
        this.remaining = this.mode === 'relay' && !this.unlimited ? msg.remaining : undefined
        this.authorized = this.mode === 'relay' && msg.authorized
        if (this.unlimited || (this.upgradeBytes !== undefined && msg.remaining >= this.upgradeBytes)) this.upgradeBytes = undefined
        this.transfer?.checkBudget()
      }
    }
    this.changed()
  }

  private start(msg: Start) {
    this.closeAttempt()
    this.phase = 'connecting'
    this.mode = msg.mode
    this.busy = false
    this.requestId = undefined
    this.unlimited = msg.unlimited === true
    this.remaining = msg.mode === 'relay' && !this.unlimited ? msg.remaining : undefined
    this.authorized = msg.mode === 'relay' && msg.authorized === true
    this.upgradeBytes = undefined
    this.message = ''
    try {
      const pc = new RTCPeerConnection(iceConfig(msg.mode, msg.iceServers ?? []))
      const attempt: Attempt = {
        epoch: msg.epoch, mode: msg.mode, pc, signaling: Promise.resolve(),
        candidates: [], ready: false, checking: false,
      }
      this.attempt = attempt
      attempt.timer = setTimeout(() => this.fail(attempt, '建立连接超时。'), 25_000)
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && this.attempt === attempt) this.send({ type: 'signal', epoch: msg.epoch, data: candidate.toJSON() })
      }
      pc.onconnectionstatechange = () => this.connectionChanged(attempt)
      pc.ondatachannel = ({ channel }) => {
        if (!msg.initiator && channel.label === 'file-transfer' && !attempt.channel) this.bind(attempt, channel)
        else channel.close()
      }
      if (msg.initiator) {
        this.bind(attempt, pc.createDataChannel('file-transfer', { ordered: true }))
        this.enqueue(attempt, async () => {
          await pc.setLocalDescription(await pc.createOffer())
          this.sendDescription(attempt)
        })
      }
    } catch {
      this.closeAttempt()
      this.phase = 'failed'
      this.message = '无法初始化浏览器连接。'
      this.send({ type: 'failed', epoch: msg.epoch })
    }
  }

  private enqueue(attempt: Attempt, action: () => Promise<void>) {
    attempt.signaling = attempt.signaling.then(async () => {
      if (this.attempt === attempt) await action()
    }).catch(() => this.fail(attempt, '无法完成连接协商。'))
  }

  private sendDescription(attempt: Attempt) {
    if (this.attempt === attempt && attempt.pc.localDescription) {
      this.send({ type: 'signal', epoch: attempt.epoch, data: attempt.pc.localDescription.toJSON() })
    }
  }

  private signal(attempt: Attempt, data: Signal) {
    if (!data || typeof data !== 'object') return
    this.enqueue(attempt, async () => {
      const { pc, candidates } = attempt
      if ('type' in data && (data.type === 'offer' || data.type === 'answer')) {
        await pc.setRemoteDescription(data)
        for (const candidate of candidates.splice(0)) {
          if (this.attempt !== attempt) return
          await pc.addIceCandidate(candidate)
        }
        if (data.type === 'offer' && this.attempt === attempt) {
          await pc.setLocalDescription(await pc.createAnswer())
          this.sendDescription(attempt)
        }
      } else if ('candidate' in data && typeof data.candidate === 'string') {
        if (pc.remoteDescription) await pc.addIceCandidate(data)
        else candidates.push(data)
      }
    })
  }

  private bind(attempt: Attempt, channel: RTCDataChannel) {
    attempt.channel = channel
    // Install the receiver before either side sends application messages.
    const transfer: Transfer = new Transfer(channel, this.role === 'host', () => {
      if (this.transfer === transfer) {
        this.retryFile = transfer.retryFile
        if (transfer.view.phase === 'unconfirmed') {
          this.unconfirmedSave = { name: transfer.view.name, message: transfer.view.message }
        }
      }
      if (this.finishingSave === transfer && transfer.view.phase !== 'saving') {
        this.finishingSave = undefined
        this.detachedSave = { name: transfer.view.name, saved: transfer.view.phase === 'done' }
      }
      this.changed()
    }, () => this.mode === 'relay' ? this.remaining : undefined, bytes => {
      if (this.mode !== 'relay' || this.remaining === undefined || bytes > MAX_FILE) return
      // The peer can have a newer balance update. Its explicit request also opens the key form.
      this.upgradeBytes = Math.max(this.upgradeBytes ?? 0, bytes)
      this.changed()
    }, incoming => {
      if (this.finishingSave || channel.readyState !== 'open' || (!incoming && !attempt.ready)) return false
      // A guest offer sent before it sees the reservation gets to proceed.
      return !attempt.upgrade || (incoming && attempt.upgrade.phase === 'preparing')
    }, msg => this.receiveUpgrade(attempt, msg), () => this.unlimited)
    this.transfer = transfer
    transfer.retryFile = this.retryFile
    channel.onopen = () => this.connectionChanged(attempt)
    channel.onclose = channel.onerror = () => this.fail(attempt, '设备之间的数据连接已断开。')
    if (attempt.mode === 'relay') attempt.pathCheck = setInterval(() => void this.checkPath(attempt), 500)
    this.connectionChanged(attempt)
  }

  private connectionChanged(attempt: Attempt) {
    if (this.attempt !== attempt) return
    const state = attempt.pc.connectionState
    if (state === 'failed' || state === 'closed') {
      this.fail(attempt, '设备之间的连接已断开。')
    } else if (state === 'disconnected' && attempt.ready && !attempt.timer) {
      attempt.timer = setTimeout(() => this.fail(attempt, '设备之间的连接已断开。'), 8_000)
    } else if (state === 'connected' && attempt.channel?.readyState === 'open') {
      void this.checkPath(attempt)
    }
  }

  private async checkPath(attempt: Attempt) {
    if (this.attempt !== attempt || attempt.checking || attempt.pc.connectionState !== 'connected' ||
      attempt.channel?.readyState !== 'open') return
    attempt.checking = true
    try {
      const verified = attempt.mode === 'direct' || await usesRelay(attempt.pc)
      if (this.attempt !== attempt || attempt.pc.connectionState !== 'connected') return
      if (!verified) {
        if (attempt.ready) this.fail(attempt, '当前连接的中继路径无法验证。')
        return
      }
      clearTimeout(attempt.timer)
      attempt.timer = undefined
      if (!attempt.ready) {
        attempt.ready = true
        this.phase = 'connected'
        this.send({ type: 'ready', epoch: attempt.epoch })
        this.changed()
      }
    } catch {
      if (attempt.ready) this.fail(attempt, '无法检查中继路径。')
    } finally {
      attempt.checking = false
    }
  }

  private fail(attempt: Attempt, message: string) {
    if (this.attempt !== attempt) return
    this.closeAttempt()
    this.phase = 'failed'
    this.busy = false
    this.message = message
    this.send({ type: 'failed', epoch: attempt.epoch })
    this.changed()
  }

  private closeAttempt() {
    const attempt = this.attempt
    this.attempt = undefined
    if (this.transfer?.view.phase === 'saving') this.finishingSave = this.transfer
    if (this.transfer?.unreportedSave) this.detachedSave = this.transfer.unreportedSave
    this.transfer?.dispose()
    this.transfer = undefined
    if (!attempt) return
    clearTimeout(attempt.timer)
    if (attempt.upgrade?.phase === 'preparing') clearTimeout(attempt.upgrade.timer)
    clearInterval(attempt.pathCheck)
    attempt.channel?.close()
    attempt.pc.close()
  }

  private reset(message: string) {
    this.closeAttempt()
    this.phase = 'idle'
    this.token = undefined
    this.lastEpoch = undefined
    this.role = undefined
    this.code = ''
    this.expiresAt = undefined
    this.mode = undefined
    this.requestId = undefined
    this.busy = false
    this.remaining = undefined
    this.authorized = false
    this.unlimited = false
    this.upgradeBytes = undefined
    this.retryFile = undefined
    // Save outcomes belong to the page and can arrive after the room closes.
    this.message = message
  }
}
