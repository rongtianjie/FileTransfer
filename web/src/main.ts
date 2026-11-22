import './style.css'
import { Session } from './session.ts'
import type { Transfer } from './transfer.ts'
import { mountAdminEntry } from './admin/entry.ts'
import { formatByteSize } from './byte-size.ts'
import {
  MEMORY_LIMIT, clearStaleReceived, detectReceiveMode, memoryWriter, opfsWriter, receiveLimit, saveToDevice,
  type Received,
} from './receive.ts'
import { SpeedMeter, formatSpeed } from './speed.ts'

type PickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

// Same file name rules for single saves and folders: path separators and control characters are unsafe.
function safeName(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : '接收的文件'
}

// Never overwrite: an existing "a.txt" makes the next file "a (1).txt".
async function createInFolder(folder: FileSystemDirectoryHandle, wanted: string) {
  const name = safeName(wanted)
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let copy = 0; copy < 1000; copy++) {
    const candidate = copy ? `${stem} (${copy})${ext}` : name
    try {
      await folder.getFileHandle(candidate)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return (await folder.getFileHandle(candidate, { create: true })).createWritable()
      }
      throw error
    }
  }
  throw new Error('同名文件过多')
}

const picker = (window as PickerWindow).showSaveFilePicker
const folderPicker = (window as PickerWindow).showDirectoryPicker
const receiveMode = detectReceiveMode({
  picker: Boolean(picker),
  opfs: window.isSecureContext && typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype,
})
const supportIssue = !window.RTCPeerConnection ? '当前浏览器不支持 WebRTC，无法使用本服务。' : ''

const storageLabel = { picker: '极速流式落盘', opfs: '分块暂存后保存', memory: '内存接收' }[receiveMode]
const storageTip = {
  picker: '支持 File System Access API，边接收边写入磁盘，不占用浏览器运行内存。',
  opfs: '此浏览器不能直接写入你选择的位置。文件会先分块暂存到浏览器存储，接收完成后点击“保存到设备”。',
  memory: `此浏览器只能在内存中接收，单个文件最大 ${MEMORY_LIMIT / 1024 / 1024} MiB。更大的文件请使用桌面版 Chrome 或 Edge 接收。`,
}[receiveMode]

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header class="top"><div class="frame bar">
    <div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i></span>直达</div>
    <div class="bar-end">
      <span id="admin-relay-totals" class="admin-relay-totals" hidden></span>
      <div class="socket"><span class="dot" aria-hidden="true"></span><span id="socket-label"></span></div>
      <div id="admin-entry"></div>
    </div>
  </div></header>
  <main class="frame">
    <section class="intro" aria-labelledby="title">
      <p class="category">点对点文件传输</p>
      <h1 id="title">文件，直达。</h1>
      <p class="subtitle">输入相同房间码，两台设备直接建立端到端加密传输通道。</p>
    </section>
    <section class="console" aria-label="传输控制台">
      <div class="route" id="route">
        <div class="endpoint"><span class="terminal" aria-hidden="true"></span><span>本机</span></div>
        <div class="path"><span id="path-label" class="tip-trigger tip-text" tabindex="0" aria-describedby="path-tip"><span id="path-text">等待建立连接</span><span id="path-tip" class="tip-bubble" role="tooltip">两端加入相同房间后，将自动建立安全传输通道。</span></span></div>
        <div class="endpoint"><span class="terminal" aria-hidden="true"></span><span>对方</span></div>
      </div>
      <div class="workspace">
        <section id="home" class="actions" aria-label="创建或加入房间">
          <form data-form="create">
            <h2>创建房间</h2>
            <div class="field-label">
              <label for="create-code">自定义房间码<span class="optional">（可选）</span></label>
              <span class="tip-trigger" tabindex="0" aria-describedby="create-tip">
                <span class="sr-only">房间码说明</span>
                <span class="help-icon" aria-hidden="true">?</span>
                <span id="create-tip" class="tip-bubble" role="tooltip">可填入 4 位数字作为专属房间码；留空将由系统自动分配。</span>
              </span>
            </div>
            <input id="create-code" name="code" placeholder="留空自动生成 4 位房间码" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" title="请输入 4 位数字" spellcheck="false" autocomplete="off">
            <button class="primary" type="submit">创建房间</button>
          </form>
          <form data-form="join">
            <h2>加入房间</h2>
            <div class="field-label">
              <label for="join-code">对方的房间码</label>
              <span class="tip-trigger" tabindex="0" aria-describedby="join-tip">
                <span class="sr-only">加入房间说明</span>
                <span class="help-icon" aria-hidden="true">?</span>
                <span id="join-tip" class="tip-bubble" role="tooltip">输入对方创建房间后分享的 4 位数字代码，对方确认同意后即可连接。</span>
              </span>
            </div>
            <input id="join-code" name="code" placeholder="输入 4 位数字房间码" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" title="请输入 4 位数字" spellcheck="false" autocomplete="off" required>
            <button class="secondary" type="submit">申请加入</button>
          </form>
        </section>
        <div id="room" hidden></div>
        <div id="notice" class="notice" role="status" hidden></div>
        <button id="reconnect" class="secondary" type="button" data-action="reconnect" hidden>重新连接服务</button>
      </div>
    </section>
    <div id="save-notices"></div>
    <footer>
      <span class="tip-trigger tip-text" tabindex="0" aria-describedby="signup-tip">无需注册<span id="signup-tip" class="tip-bubble" role="tooltip">开箱即用，无需登录或绑定个人账号，保障数据隐私。</span></span>
      <span class="tip-trigger tip-text" tabindex="0" aria-describedby="size-tip">支持大文件传输<span id="size-tip" class="tip-bubble" role="tooltip">普通房间单文件支持高达 2 GiB。有管理员登录的房间不设单文件上限。</span></span>
      <span class="tip-trigger tip-text" tabindex="0" aria-describedby="encryption-tip">端到端加密<span id="encryption-tip" class="tip-bubble" role="tooltip">基于 WebRTC 原生 DTLS/SCTP 加密协议，传输数据不经第三方留存。</span></span>
      <span class="tip-trigger tip-text" tabindex="0" aria-describedby="storage-tip">${storageLabel}<span id="storage-tip" class="tip-bubble" role="tooltip">${storageTip}</span></span>
    </footer>
  </main>
  <input id="file-input" type="file" multiple hidden>
  <div id="announcement" class="sr-only" role="status"></div>
  <div id="save-announcement" class="sr-only" role="status"></div>
`

const find = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const syncAdminRoom = mountAdminEntry(find('admin-entry'), find('admin-relay-totals'))
const home = find('home')
const room = find('room')
const fileInput = find<HTMLInputElement>('file-input')
const session = new Session(render)
session.autoReconnect = true
session.receiveLimit = () => receiveLimit(receiveMode)
const speed = new SpeedMeter()
let speedTransfer: Transfer | undefined
const baseTitle = document.title
let roomMarkup = ''
let keyValue = ''
let keyRoom = ''
let copyMessage = ''
let copyRequest = 0
let fileTarget: Transfer | undefined
let saveMarkup = ''
let lastTransferPhase = ''
let lastRequest: string | undefined
let qrLink = ''
type Held = Received & { id: number; saved: boolean }
const held: Held[] = []
let heldId = 0
let qrSvg = ''
let scheduled = false

// A hidden tab cannot be seen, so surface the event in its title until it is focused again.
function alertTab(text: string) {
  if (document.hidden) document.title = `（${text}）${baseTitle}`
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = baseTitle
})

function html(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

function render() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    draw()
  })
}

const phases: Record<string, string> = {
  idle: '',
  waiting: '等待对方接收…',
  offered: '收到文件传输请求',
  picking: '正在选择保存位置…',
  sending: '正在发送文件…',
  receiving: '正在接收文件…',
  saving: '正在完成写入…',
  confirming: '等待对方确认保存…',
  unconfirmed: '保存结果未确认',
  done: '文件传输完成',
  stopped: '传输已停止',
}

function retainedLabel() {
  const [first] = session.retryFiles
  return !first ? '' : session.retryFiles.length > 1 ? `${first.name} 等 ${session.retryFiles.length} 个文件` : first.name
}

function acceptButton(batch: number | undefined) {
  if (receiveMode !== 'picker') {
    return `<button class="primary" type="button" data-action="save-local">${batch ? `接收 ${batch} 个文件` : '接收文件'}</button>`
  }
  return batch && folderPicker
    ? `<button class="primary" type="button" data-action="save-batch">选择文件夹并接收 ${batch} 个文件</button>`
    : '<button class="primary" type="button" data-action="save">选择位置并接收</button>'
}

function transferMarkup() {
  const transfer = session.transfer
  const view = transfer?.view
  const phase = view?.phase ?? 'idle'
  const free = Boolean(transfer?.canOffer)
  const disabled = session.switchingRelay || session.savingAfterDisconnect
  const blocked = disabled ? 'disabled' : ''
  const progress = ['sending', 'receiving', 'saving', 'confirming', 'done'].includes(phase)
  return `
    <section class="transfer" aria-labelledby="transfer-title">
      <div class="transfer-head">
        <h2 id="transfer-title">${phase === 'idle' ? '传输文件' : phases[phase]}</h2>
        ${free || disabled ? `<button class="primary" type="button" data-action="select" ${blocked}>选择文件</button>` : ''}
      </div>
      ${view?.name ? `<p class="file-name"><bdi>${html(view.name)}</bdi><span>${view.batchTotal ? `第 ${view.batchIndex} / ${view.batchTotal} 个 · ` : ''}${formatByteSize(view.size)}</span></p>` : ''}
      ${progress ? '<div class="progress"><progress id="progress" aria-label="已写入的字节数" max="1" value="0"></progress><span id="progress-text"></span></div>' : ''}
      ${view?.message ? `<p class="muted">${html(view.message)}</p>` : ''}
      ${session.switchingRelay ? '<p class="muted" role="status">正在协调中继切换，完成后可传输文件。</p>' : ''}
      ${phase === 'idle' && free ? '<p class="muted">点击“选择文件”或把文件拖到此处即可发送，可一次选择多个；双方任意一台设备均可发起传输。</p>' : ''}
      ${phase === 'offered' ? `<div class="button-row">${acceptButton(view?.batchTotal)}<button class="secondary" type="button" data-action="cancel">拒收</button></div>${receiveMode === 'picker' ? '' : '<p class="muted">文件会先暂存在浏览器中，接收完成后点击“保存到设备”。</p>'}` : ''}
      ${['waiting', 'picking', 'sending', 'receiving'].includes(phase) ? '<button class="secondary" type="button" data-action="cancel">取消传输</button>' : ''}
      ${free && session.retryFile ? `<button class="secondary retry-file" type="button" data-action="resend">重新发送</button><p class="muted retained">已保留未完成文件：<bdi>${html(retainedLabel())}</bdi></p>` : ''}
    </section>
  `
}

function relayMarkup() {
  if (session.phase !== 'failed' && !session.canUpgrade) {
    if (session.mode === 'relay' && session.phase === 'connected' && session.upgradeBytes !== undefined) {
      return '<p class="muted">当前中继余量不足以传输此文件。</p>'
    }
    return ''
  }
  const disabled = (session.busy || (session.phase === 'connected' && !session.transfer?.canOffer)) ? 'disabled' : ''
  if (session.role === 'guest') {
    return session.phase === 'failed'
      ? '<p class="muted">两端直连受限，等待房主重试直连或切换中继模式…</p>'
      : `<div class="relay-options"><p class="muted">当前公用中继余量不足以传输此文件，可提醒房主输入专属密钥。</p><button type="button" class="secondary" data-action="ask" ${disabled}>提醒房主输入密钥</button></div>`
  }
  return `
    <div class="relay-options">
      ${session.phase === 'failed' && session.relayAvailable ? '<p class="muted">两端未能直接连通。您可以重试建立直连，或开启加密中继模式由服务器协助转发。</p>' : ''}
      ${session.canUpgrade ? '<p class="muted">当前公用中继余量不足以传输此文件。若持有管理员分配的专属密钥，可在下方输入。</p>' : ''}
      <div class="button-row">
        ${session.phase === 'failed' ? `<button class="primary" type="button" data-action="direct" ${disabled}>重试直连</button>` : ''}
        ${session.phase === 'failed' && session.relayAvailable ? `<button class="secondary" type="button" data-action="relay" ${disabled}>${session.mode === 'relay' ? '重试加密中继' : '启用加密中继'}</button>` : ''}
      </div>
      ${session.relayAvailable && session.keyAvailable && !session.unlimited ? `
        <form class="key-form" data-form="key">
          <div class="field-label">
            <label for="relay-key">中继密钥</label>
            <span class="tip-trigger" tabindex="0" aria-describedby="key-tip">
              <span class="sr-only">中继密钥说明</span>
              <span class="help-icon" aria-hidden="true">?</span>
              <span id="key-tip" class="tip-bubble" role="tooltip">普通房间可由房主输入中继密钥来使用保留额度。</span>
            </span>
          </div>
          <div class="button-row">
            <input id="relay-key" name="key" type="password" placeholder="请输入中继密钥" autocomplete="off" maxlength="512" required ${disabled}>
            <button class="secondary" type="submit" ${disabled}>解锁额度</button>
          </div>
        </form>` : ''}
    </div>`
}

function roomContent() {
  const lobby = session.phase === 'lobby'
  const host = session.role === 'host'
  const code = html(session.code)
  let heading: string
  if (lobby) heading = session.requestId ? '收到加入申请' : host ? '等待对方加入' : '等待房主确认'
  else if (session.phase === 'connecting') heading = session.mode === 'relay' ? '正在连接中继服务…' : '正在建立点对点直连…'
  else if (session.phase === 'failed') heading = '连接已断开'
  else heading = '两台设备已连通'

  const expiry = lobby && session.expiresAt && Number.isFinite(session.expiresAt)
    ? new Date(session.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''

  return `
    <div class="room-header">
      <div><span class="muted">房间码</span> <strong class="code"><bdi>${code}</bdi></strong></div>
      <div class="button-row compact">
        ${host ? '<button class="plain" type="button" data-action="copy">复制邀请链接</button>' : ''}
        <button class="plain leave" type="button" data-action="leave">离开房间</button>
      </div>
    </div>
    ${host ? '<p id="copy-feedback" class="copy-feedback muted" role="status"></p>' : ''}
    <div class="room-status">
      <h2 id="room-heading" tabindex="-1">${heading}</h2>
      ${session.mode === 'relay' && session.phase === 'connected' ? `<span class="balance" id="relay-balance"></span>` : ''}
    </div>
    ${lobby && host && !session.requestId && !session.busy ? `<p class="muted">请把邀请链接或上方 4 位房间码分享给对方；对方申请加入后在此确认即可连通。${expiry ? `（有效至 ${expiry}）` : ''}</p>` : ''}
    ${lobby && host && !session.requestId && qrSvg ? `<div class="invite"><div class="invite-qr" role="img" aria-label="加入房间的二维码">${qrSvg}</div><p class="muted">用手机扫码即可打开链接并加入。</p></div>` : ''}
    ${lobby && !host && !session.requestId ? `<p class="muted">已向房主发出加入申请，请等待对方确认同意…</p>` : ''}
    ${session.requestId ? `
      <p class="muted">对方正在申请加入此房间，是否同意建立传输连接？</p>
      <div class="button-row">
        <button class="primary" type="button" data-action="accept" data-request-id="${html(session.requestId)}">同意加入</button>
        <button class="secondary" type="button" data-action="reject" data-request-id="${html(session.requestId)}">拒绝</button>
      </div>` : ''}
    ${session.phase === 'connected' ? transferMarkup() : ''}
    ${session.phase !== 'connected' && session.retryFile ? `<p class="muted retained">连接恢复后可一键重发：<bdi>${html(retainedLabel())}</bdi></p>` : ''}
    ${relayMarkup()}
  `
}

// The QR code is built lazily: most visits never create a room.
function syncInvite() {
  const wanted = session.phase === 'lobby' && session.role === 'host' && session.code && !session.requestId
  const link = wanted ? `${location.origin}/#${session.code}` : ''
  if (link === qrLink) return
  qrLink = link
  qrSvg = ''
  if (!link) return
  void import('./qr.ts').then(({ inviteQr, inviteReachable }) => {
    if (qrLink !== link || !inviteReachable(location.hostname)) return
    qrSvg = inviteQr(link)
    render()
  })
}

function setText(id: string, value: string) {
  const element = find(id)
  if (element && element.textContent !== value) element.textContent = value
}

let previousPhase = session.phase
function draw() {
  syncAdminRoom(session.adminProof)
  syncInvite()
  const idle = session.phase === 'idle'
  const active = document.activeElement as HTMLElement | null
  const stateChanged = previousPhase !== session.phase
  previousPhase = session.phase
  home.hidden = !idle
  room.hidden = idle
  const codeKey = idle ? '' : session.code
  if (stateChanged && session.phase === 'connecting') keyValue = ''
  if (codeKey !== keyRoom) {
    keyRoom = codeKey
    keyValue = ''
    copyMessage = ''
    copyRequest++
  }
  for (const control of home.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
    control.disabled = Boolean(supportIssue) || session.socketState !== 'open' || session.busy
  }
  find('reconnect').hidden = Boolean(supportIssue) || session.socketState !== 'offline'
  find('route').dataset.phase = session.phase
  find('route').dataset.mode = session.mode ?? ''
  document.querySelector<HTMLElement>('.socket')!.dataset.state = session.socketState
  setText('socket-label', supportIssue ? '浏览器受限' : { connecting: '正在连接服务', open: '服务已就绪', offline: '服务已离线' }[session.socketState])

  let pathText = '等待建立连接'
  let pathTip = '两端加入相同房间并确认后，将自动建立安全传输通道。'
  if (session.phase === 'connected') {
    if (session.mode === 'relay') {
      pathText = '加密中继已连通'
      pathTip = '端到端加密中继：数据经由中继服务器转发，密文传输保障跨网络穿透连通性。'
    } else {
      pathText = 'P2P 直连已连通'
      pathTip = '点对点直接传输：数据在两台设备间直连传输，不经服务器中转，速度最快且不限流量。'
    }
  } else if (session.phase === 'connecting') {
    if (session.mode === 'relay') {
      pathText = '中继协商中…'
      pathTip = '正在通过中继服务器与对方设备建立加密传输通道…'
    } else {
      pathText = '直连协商中…'
      pathTip = '正在通过 WebRTC 与对方设备建立点对点直连…'
    }
  } else if (session.phase === 'failed') {
    pathText = '连接已断开'
    pathTip = '两端连接中断，可尝试重试直连或切换至加密中继模式。'
  }
  setText('path-text', pathText)
  setText('path-tip', pathTip)

  if (!idle) {
    const markup = roomContent()
    if (markup !== roomMarkup) {
      const restore = active && room.contains(active)
        ? active.id ? `#${active.id}` : active.dataset.action ? `[data-action="${active.dataset.action}"]` : active.matches('button[type="submit"]') ? '.key-form button' : ''
        : ''
      const selection = active instanceof HTMLInputElement && active.id === 'relay-key'
        ? [active.selectionStart, active.selectionEnd] as const : undefined
      room.innerHTML = markup
      roomMarkup = markup
      const key = room.querySelector<HTMLInputElement>('#relay-key')
      if (key) key.value = keyValue
      const replacement = restore && room.querySelector<HTMLElement>(restore)
      const nextRequest = replacement ? replacement.dataset.requestId : undefined
      if (replacement && !replacement.matches(':disabled') && nextRequest === active?.dataset.requestId) {
        replacement.focus({ preventScroll: true })
        if (selection && key === replacement) key.setSelectionRange(...selection)
      } else if (restore || stateChanged) {
        find('room-heading').focus({ preventScroll: true })
      }
    }
  } else {
    room.replaceChildren()
    roomMarkup = ''
    if (stateChanged) home.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()
  }

  setText('copy-feedback', copyMessage)
  if (find('relay-balance')) {
    const remaining = session.remaining
    setText('relay-balance', session.unlimited ? '管理员中继不限额' :
      (session.authorized ? '专属中继余量' : '免密中继余量') +
      (remaining === undefined ? '' : ` ${formatByteSize(Math.max(0, remaining))}`))
  }
  const view = session.transfer?.view
  const progress = find<HTMLProgressElement>('progress')
  if (progress && view) {
    progress.max = view.size || 1
    progress.value = view.size ? view.bytes : view.phase === 'done' ? 1 : 0
    const percent = view.size ? Math.min(100, Math.round((view.bytes / view.size) * 100)) : (view.phase === 'done' ? 100 : 0)
    const transfer = session.transfer
    if (transfer !== speedTransfer || view.phase === 'saving' || view.bytes === 0) {
      speed.reset()
      speedTransfer = transfer
    }
    const now = performance.now()
    let rate = ''
    if (view.phase === 'sending' || view.phase === 'receiving') {
      speed.add(view.bytes, now)
      rate = formatSpeed(speed.rate(now), view.size - view.bytes)
    }
    setText('progress-text', `已写入 ${formatByteSize(view.bytes)} / ${formatByteSize(view.size)} (${percent}%)${rate && ` · ${rate}`}`)
  }
  const transferPhase = view?.phase ?? ''
  if (transferPhase !== lastTransferPhase) {
    setText('announcement', transferPhase ? (phases[view!.phase] || '') : '')
    lastTransferPhase = transferPhase
    if (transferPhase === 'offered') alertTab('收到文件')
    else if (transferPhase === 'done') alertTab('传输完成')
  }
  if (session.requestId !== lastRequest) {
    lastRequest = session.requestId
    if (lastRequest) alertTab('有人申请加入')
  }
  const unknown = session.unconfirmedSave
  const detached = session.detachedSave
  const waitingSave = session.savingAfterDisconnect ? '连接已断开，仍在完成本地文件保存。' : ''
  const localResult = detached?.saved ? '文件已保存到本机。' : '文件保存失败。'
  const remoteResult = unknown && view?.phase !== 'unconfirmed' ? unknown : undefined
  const saves = `
    ${remoteResult ? saveNotice('dismiss-unconfirmed', remoteResult.name, remoteResult.message) : ''}
    ${heldMarkup()}
    ${waitingSave ? `<p class="notice">${waitingSave}</p>` : ''}
    ${detached ? saveNotice('dismiss-detached', detached.name, localResult) : ''}`
  if (saves !== saveMarkup) {
    find('save-notices').innerHTML = saves
    saveMarkup = saves
    setText('save-announcement', [
      remoteResult && `${remoteResult.name} ${remoteResult.message}`,
      waitingSave,
      detached && `${detached.name} ${localResult}`,
      held.length && `已接收 ${held.length} 个文件，请保存到设备。`,
    ].filter(Boolean).join(' '))
  }

  const notice = find('notice')
  const message = supportIssue || session.message || (session.busy && idle ? '正在处理房间请求…' : '')
  if (notice.textContent !== message) notice.textContent = message
  notice.hidden = !message
}

function heldMarkup() {
  if (!held.length) return ''
  const all = held.length > 1 ? '<div class="button-row"><button class="primary" type="button" data-action="save-all">全部保存到设备</button></div>' : ''
  const rows = held.map(file => `
    <div class="notice save-notice">
      <p><bdi>${html(file.name)}</bdi> · ${formatByteSize(file.size)} · ${file.saved ? '已保存，可关闭此提示' : '已接收，点击保存到设备'}</p>
      <div class="button-row compact">
        <button class="primary" type="button" data-action="save-file" data-id="${file.id}">${file.saved ? '再次保存' : '保存到设备'}</button>
        <button class="plain" type="button" data-action="drop-file" data-id="${file.id}">${file.saved ? '关闭' : '丢弃'}</button>
      </div>
    </div>`).join('')
  return all + rows
}

// A hidden or private-storage file only exists until this page closes, so ask before leaving.
const hasUnsaved = () => held.some(file => !file.saved)

async function openLocal(name: string, size: number) {
  const onDone = (file: Received) => {
    held.push({ ...file, id: ++heldId, saved: false })
    render()
    void refreshLimit()
  }
  const filename = safeName(name)
  if (receiveMode === 'opfs') {
    try {
      return await opfsWriter(await navigator.storage.getDirectory(), filename, onDone)
    } catch {
      // Some engines expose the API without a writable stream; fall through to memory if it fits.
    }
  }
  if (size > MEMORY_LIMIT) throw new Error('文件过大，无法在此浏览器接收')
  return memoryWriter(filename, onDone)
}

async function refreshLimit() {
  if (receiveMode !== 'opfs') return
  try {
    const estimate = await navigator.storage.estimate()
    session.receiveLimit = () => receiveLimit('opfs', estimate)
  } catch {
    // Keep the previous limit.
  }
}

function saveNotice(action: string, name: string, message: string) {
  return `<div class="notice save-notice"><p><bdi>${html(name)}</bdi> · ${html(message)}</p><button class="plain" type="button" data-action="${action}">关闭提示</button></div>`
}

app.addEventListener('submit', event => {
  event.preventDefault()
  const form = event.target as HTMLFormElement
  const data = new FormData(form)
  const type = form.dataset.form
  if (type === 'create' || type === 'join') {
    const code = String(data.get('code')).trim()
    const input = form.querySelector<HTMLInputElement>('input')!
    if (type === 'join' && !code) {
      input.setCustomValidity('请输入 4 位房间码。')
      input.reportValidity()
      return
    }
    session.enter(type === 'create' ? 'host' : 'guest', code)
  } else if (type === 'key') {
    const key = String(data.get('key'))
    if (key) session.relay(key)
  }
})

app.addEventListener('input', event => {
  if (!(event.target instanceof HTMLInputElement)) return
  event.target.setCustomValidity('')
  if (event.target.id === 'relay-key') keyValue = event.target.value
})

app.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')
  const transfer = session.transfer
  switch (button?.dataset.action) {
    case 'reconnect': session.connect(); break
    case 'copy':
      if (session.code) {
        const code = session.code
        const request = ++copyRequest
        const copying = navigator.clipboard?.writeText(`${location.origin}/#${code}`) ?? Promise.reject()
        void copying.then(
          () => { if (copyRequest === request && session.code === code) copyMessage = '邀请链接已复制到剪贴板。' },
          () => { if (copyRequest === request && session.code === code) copyMessage = '无法自动复制，请手动分享上方房间码。' },
        ).finally(render)
      }
      break
    case 'leave':
      copyRequest++
      copyMessage = ''
      session.leave()
      break
    case 'dismiss-unconfirmed': session.unconfirmedSave = undefined; render(); break
    case 'dismiss-detached': session.detachedSave = undefined; render(); break
    case 'accept': session.answer(true, button?.dataset.requestId); break
    case 'reject': session.answer(false, button?.dataset.requestId); break
    case 'direct': session.retryDirect(); break
    case 'relay': session.relay(); break
    case 'ask': session.askForUpgrade(); break
    case 'cancel': transfer?.cancel(); break
    case 'resend': if (session.phase === 'connected') transfer?.retry(); break
    case 'select':
      if (session.phase === 'connected' && transfer?.canOffer) {
        fileTarget = transfer
        fileInput.click()
      }
      break
    case 'save':
      if (picker && transfer && session.phase === 'connected') {
        const name = safeName(transfer.view.name)
        void transfer.accept(async () => (await picker.call(window, { suggestedName: name })).createWritable())
      }
      break
    case 'save-local':
      if (receiveMode !== 'picker' && transfer && session.phase === 'connected') {
        // Size is read per file because later files of a batch open without another click.
        const open = (name: string) => openLocal(name, transfer.view.size)
        if (transfer.view.batchTotal) void transfer.acceptBatch(open)
        else void transfer.accept(() => open(transfer.view.name))
      }
      break
    case 'save-file': {
      const file = held.find(item => String(item.id) === button?.dataset.id)
      if (file) { saveToDevice(file); file.saved = true; render() }
      break
    }
    case 'save-all':
      for (const file of held) { saveToDevice(file); file.saved = true }
      render()
      break
    case 'drop-file': {
      const index = held.findIndex(item => String(item.id) === button?.dataset.id)
      if (index >= 0) { void held[index].discard(); held.splice(index, 1); render() }
      break
    }
    case 'save-batch':
      if (folderPicker && transfer && session.phase === 'connected') {
        // The folder is asked for once; later files in the batch reuse it.
        let folder: FileSystemDirectoryHandle | undefined
        void transfer.acceptBatch(async name => {
          folder ??= await folderPicker.call(window, { mode: 'readwrite' })
          return createInFolder(folder, name)
        })
      }
      break
  }
})

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? [])
  fileInput.value = ''
  const target = fileTarget
  fileTarget = undefined
  if (files.length && session.phase === 'connected' && session.transfer === target) target?.offerFiles(files)
})

function tooltipTrigger(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>('.tip-trigger') : null
}

for (const eventName of ['pointerover', 'focusin']) {
  app.addEventListener(eventName, event => {
    const trigger = tooltipTrigger(event.target)
    const bubble = trigger?.querySelector<HTMLElement>(':scope > .tip-bubble')
    if (!trigger || !bubble) return
    const { left, width } = trigger.getBoundingClientRect()
    const idealLeft = left + (width - bubble.offsetWidth) / 2
    const rightLimit = document.documentElement.clientWidth - bubble.offsetWidth - 8
    const shift = Math.max(8, Math.min(idealLeft, rightLimit)) - idealLeft
    bubble.style.setProperty('--tip-shift', `${shift}px`)
  })
}

for (const eventName of ['pointerout', 'focusout'] as const) {
  app.addEventListener(eventName, event => {
    const trigger = tooltipTrigger(event.target)
    if (!trigger || tooltipTrigger(event.relatedTarget) === trigger) return
    if (eventName === 'focusout' ? !trigger.matches(':hover') : document.activeElement !== trigger) {
      delete trigger.dataset.tipDismissed
    }
  })
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  for (const trigger of app.querySelectorAll<HTMLElement>('.tip-trigger:is(:focus, :hover)')) {
    trigger.dataset.tipDismissed = ''
  }
})

const droppable = () => session.phase === 'connected' && Boolean(session.transfer?.canOffer) &&
  !session.switchingRelay && !session.savingAfterDisconnect
const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true
const console_ = document.querySelector<HTMLElement>('.console')!

// Always cancel the default so a missed drop never navigates away from an active room.
document.addEventListener('dragover', event => {
  if (!hasFiles(event)) return
  event.preventDefault()
  const accepted = droppable()
  event.dataTransfer!.dropEffect = accepted ? 'copy' : 'none'
  console_.classList.toggle('dragging', accepted)
})
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget) console_.classList.remove('dragging')
})
document.addEventListener('drop', event => {
  if (!hasFiles(event)) return
  event.preventDefault()
  console_.classList.remove('dragging')
  const transfer = session.transfer
  const files = Array.from(event.dataTransfer!.files)
  if (!droppable() || !transfer || !files.length) return
  // Folders cannot be sent; refuse the whole drop rather than silently skipping part of it.
  const items = Array.from(event.dataTransfer!.items)
  if (items.some(item => item.webkitGetAsEntry?.()?.isFile === false)) {
    session.message = '暂不支持发送文件夹，请选择文件。'
    render()
    return
  }
  session.message = ''
  transfer.offerFiles(files)
})

// Closing the tab mid-transfer silently aborts it, so ask first.
window.addEventListener('beforeunload', event => {
  const phase = session.transfer?.view.phase
  if (phase === 'sending' || phase === 'receiving' || phase === 'saving' || phase === 'confirming' || session.savingAfterDisconnect || hasUnsaved()) {
    event.preventDefault()
    event.returnValue = ''
  }
})

window.addEventListener('online', () => session.reconnectNow())

if (receiveMode === 'opfs') {
  void navigator.storage.getDirectory().then(clearStaleReceived).catch(() => {})
  void refreshLimit()
}

// An invite link carries the room code in its fragment; fill it in without joining.
const invite = /^#(\d{4})$/.exec(location.hash)?.[1]
if (invite) {
  history.replaceState(null, '', location.pathname + location.search)
  find<HTMLInputElement>('join-code').value = invite
}

draw()
if (!supportIssue) session.connect()
