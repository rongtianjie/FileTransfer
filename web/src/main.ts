import './style.css'
import { Session } from './session.ts'
import { MAX_FILE } from './transfer.ts'
import { mountAdminEntry } from './admin/entry.ts'

type PickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>
}

const picker = (window as PickerWindow).showSaveFilePicker
const agent = navigator.userAgent
const desktopChromium = /(?:Chrome|Edg)\//.test(agent) && !/Mobile|Android|iPad|iPhone|OPR\//.test(agent)
const supportIssue = !window.isSecureContext
  ? '请通过 HTTPS 或本机 localhost 打开，才能使用文件保存功能。'
  : !picker || !window.RTCPeerConnection
    ? '请使用支持文件保存功能的桌面版 Chrome 或 Edge。'
    : ''

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header class="top"><div class="frame bar">
    <div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i></span>直达</div>
    <div class="bar-end">
      <div class="socket"><span class="dot" aria-hidden="true"></span><span id="socket-label"></span></div>
      <div id="admin-entry"></div>
    </div>
  </div></header>
  <main class="frame">
    <section class="intro" aria-labelledby="title">
      <p class="category">点对点文件传输</p>
      <h1 id="title">文件，直达。</h1>
      <p class="subtitle">和对方共享房间码，连接两台设备后即可互传文件。</p>
    </section>
    <section class="console" aria-label="传输控制台">
      <div class="route" id="route">
        <div class="endpoint"><span class="terminal" aria-hidden="true"></span><span>本机</span></div>
        <div class="path"><span id="path-label"></span></div>
        <div class="endpoint"><span class="terminal" aria-hidden="true"></span><span>对方</span></div>
      </div>
      <div class="workspace">
        <section id="home" class="actions" aria-label="创建或加入房间">
          <form data-form="create">
            <h2>创建房间</h2>
            <label for="create-code">自定义房间码<span class="optional">（可选）</span></label>
            <input id="create-code" name="code" placeholder="留空自动生成" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" title="请输入 4 位数字" spellcheck="false" autocomplete="off">
            <button class="primary" type="submit">创建房间</button>
          </form>
          <form data-form="join">
            <h2>加入房间</h2>
            <label for="join-code">对方的房间码</label>
            <input id="join-code" name="code" placeholder="输入 4 位数字" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" title="请输入 4 位数字" spellcheck="false" autocomplete="off" required>
            <button class="secondary" type="submit">申请加入</button>
          </form>
        </section>
        <div id="room" hidden></div>
        <div id="notice" class="notice" role="status" hidden></div>
        <button id="reconnect" class="secondary" type="button" data-action="reconnect" hidden>重新连接</button>
      </div>
    </section>
    <footer><span>免登录</span><span>单文件上限 2 GiB</span><span>${desktopChromium ? '桌面版 Chrome / Edge' : '当前浏览器为实验支持'}</span></footer>
  </main>
  <input id="file-input" type="file" hidden>
  <div id="announcement" class="sr-only" role="status"></div>
`

const find = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
mountAdminEntry(find('admin-entry'))
const home = find('home')
const room = find('room')
const fileInput = find<HTMLInputElement>('file-input')
const session = new Session(render)
let roomMarkup = ''
let keyValue = ''
let keyRoom = ''
let copyMessage = ''
let lastTransferPhase = ''
let scheduled = false

function bytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(2)} GiB`
}

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

const phases = {
  idle: '', waiting: '等待对方接受', offered: '收到文件', picking: '正在选择保存位置',
  sending: '正在发送', receiving: '正在接收', saving: '正在完成保存', confirming: '等待对方完成保存',
  done: '传输完成', stopped: '传输已停止',
}

function transferMarkup() {
  const transfer = session.transfer
  const view = transfer?.view
  const phase = view?.phase ?? 'idle'
  const free = phase === 'idle' || phase === 'done' || phase === 'stopped'
  const progress = ['sending', 'receiving', 'saving', 'confirming', 'done'].includes(phase)
  return `
    <section class="transfer" aria-labelledby="transfer-title">
      <div class="transfer-head">
        <h2 id="transfer-title">${phase === 'idle' ? '传输文件' : phases[phase]}</h2>
        ${free ? '<button class="primary" type="button" data-action="select">选择文件</button>' : ''}
      </div>
      ${view?.name ? `<p class="file-name"><bdi>${html(view.name)}</bdi><span>${bytes(view.size)}</span></p>` : ''}
      ${progress ? '<div class="progress"><progress id="progress" aria-label="已写入的字节数" max="1" value="0"></progress><span id="progress-text"></span></div>' : ''}
      ${view?.message ? `<p class="muted">${html(view.message)}</p>` : ''}
      ${phase === 'idle' ? '<p class="muted">对方选择保存位置后，文件才会开始发送。</p>' : ''}
      ${phase === 'offered' ? '<div class="button-row"><button class="primary" type="button" data-action="save">选择位置并保存</button><button class="secondary" type="button" data-action="cancel">拒收</button></div>' : ''}
      ${!free && phase !== 'saving' && phase !== 'confirming' && phase !== 'offered' ? '<button class="secondary" type="button" data-action="cancel">取消传输</button>' : ''}
      ${free && session.retryFile ? `<button class="secondary retry-file" type="button" data-action="resend">重新发送</button><p class="muted retained"><bdi>${html(session.retryFile.name)}</bdi></p>` : ''}
    </section>
  `
}

function relayMarkup() {
  if (session.phase !== 'failed' && !session.canUpgrade) {
    if (session.mode === 'relay' && session.phase === 'connected' && session.upgradeBytes !== undefined) {
      return '<p class="muted">中继余量不足。本房间暂无法使用密钥提升额度。</p>'
    }
    return ''
  }
  if (session.role === 'guest') {
    return session.phase === 'failed'
      ? '<p class="muted">等待发起方重试直连或切换中继。</p>'
      : '<div class="relay-options"><p>中继余量不足。请发起方输入密钥提升额度。</p><button type="button" class="secondary" data-action="ask">通知发起方</button></div>'
  }
  const disabled = session.busy ? 'disabled' : ''
  return `
    <div class="relay-options">
      ${session.phase === 'failed' && session.relayAvailable ? '<p>启用中继后，服务器会转发两台设备之间的加密流量。</p>' : ''}
      ${session.canUpgrade ? '<p>中继余量不足，输入密钥以提升额度。</p>' : ''}
      <div class="button-row">
        ${session.phase === 'failed' ? `<button class="primary" type="button" data-action="direct" ${disabled}>重试直连</button>` : ''}
        ${session.phase === 'failed' && session.relayAvailable ? `<button class="secondary" type="button" data-action="relay" ${disabled}>${session.mode === 'relay' ? '重试加密中继' : '启用加密中继'}</button>` : ''}
      </div>
      ${session.relayAvailable && session.keyAvailable ? `
        <form class="key-form" data-form="key">
          <label for="relay-key">中继密钥</label>
          <div class="button-row">
            <input id="relay-key" name="key" type="password" autocomplete="off" maxlength="512" required ${disabled}>
            <button class="secondary" type="submit" ${disabled}>使用密钥</button>
          </div>
        </form>` : ''}
    </div>`
}

function roomContent() {
  const lobby = session.phase === 'lobby'
  const host = session.role === 'host'
  const code = html(session.code)
  let heading: string
  if (lobby) heading = session.requestId ? '收到加入申请' : host ? '等待对方加入' : '等待发起方同意'
  else if (session.phase === 'connecting') heading = session.mode === 'relay' ? '正在验证中继连接' : '正在建立直连'
  else if (session.phase === 'failed') heading = '连接中断'
  else heading = '设备已连接'

  const expiry = lobby && session.expiresAt && Number.isFinite(session.expiresAt)
    ? new Date(session.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''

  return `
    <div class="room-header">
      <div><span class="muted">房间码</span> <strong class="code"><bdi>${code}</bdi></strong></div>
      <div class="button-row compact">
        ${host ? '<button class="plain" type="button" data-action="copy">复制房间码</button>' : ''}
        <button class="plain leave" type="button" data-action="leave">离开房间</button>
      </div>
    </div>
    <div class="room-status">
      <h2 id="room-heading" tabindex="-1">${heading}</h2>
      ${session.mode === 'relay' && session.phase === 'connected' ? `<span class="balance" id="relay-balance"></span>` : ''}
    </div>
    ${lobby && host && !session.requestId && !session.busy ? `<p class="muted">将房间码发给对方。${expiry ? `房间码有效至 ${expiry}。` : ''}</p>` : ''}
    ${session.requestId ? `
      <div class="button-row">
        <button class="primary" type="button" data-action="accept" data-request-id="${html(session.requestId)}">同意加入</button>
        <button class="secondary" type="button" data-action="reject" data-request-id="${html(session.requestId)}">拒绝</button>
      </div>` : ''}
    ${session.phase === 'connected' ? transferMarkup() : ''}
    ${session.phase !== 'connected' && session.retryFile ? `<p class="muted retained">连接恢复后可重发 <bdi>${html(session.retryFile.name)}</bdi></p>` : ''}
    ${relayMarkup()}
  `
}

function setText(id: string, value: string) {
  const element = find(id)
  if (element.textContent !== value) element.textContent = value
}

let previousPhase = session.phase
function draw() {
  const idle = session.phase === 'idle'
  const active = document.activeElement as HTMLElement | null
  const stateChanged = previousPhase !== session.phase
  previousPhase = session.phase
  home.hidden = !idle
  room.hidden = idle
  const codeKey = idle ? '' : session.code
  if (stateChanged && session.phase === 'connecting') {
    keyValue = ''
    copyMessage = ''
  }
  if (codeKey !== keyRoom) {
    keyRoom = codeKey
    keyValue = ''
    copyMessage = ''
  }
  for (const control of home.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
    control.disabled = Boolean(supportIssue) || session.socketState !== 'open' || session.busy
  }
  find('reconnect').hidden = Boolean(supportIssue) || session.socketState !== 'offline'
  find('route').dataset.phase = session.phase
  find('route').dataset.mode = session.mode ?? ''
  document.querySelector<HTMLElement>('.socket')!.dataset.state = session.socketState
  setText('socket-label', supportIssue ? '浏览器不受支持' : { connecting: '正在连接服务', open: '会话服务在线', offline: '会话服务离线' }[session.socketState])
  setText('path-label', session.phase === 'connected'
    ? session.mode === 'relay' ? '加密中继已连接' : '直连已连接'
    : session.phase === 'connecting' ? (session.mode === 'relay' ? '中继协商中' : '直连协商中')
      : session.phase === 'failed' ? '连接已中断' : '等待建立连接')

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

  if (find('relay-balance')) {
    const remaining = session.remaining
    setText('relay-balance', (session.authorized ? '密钥额度' : '中继余量') +
      (remaining === undefined ? '' : ` ${bytes(Math.max(0, remaining))}`))
  }
  const view = session.transfer?.view
  const progress = find<HTMLProgressElement>('progress')
  if (progress && view) {
    progress.max = view.size || 1
    progress.value = view.size ? view.bytes : view.phase === 'done' ? 1 : 0
    setText('progress-text', `已写入 ${bytes(view.bytes)} / ${bytes(view.size)}`)
  }
  const transferPhase = view?.phase ?? ''
  if (transferPhase !== lastTransferPhase) {
    setText('announcement', transferPhase ? phases[view!.phase] : '')
    lastTransferPhase = transferPhase
  }
  const notice = find('notice')
  const message = supportIssue || session.message || copyMessage || (session.busy && idle ? '正在处理房间请求。' : '')
  if (notice.textContent !== message) notice.textContent = message
  notice.hidden = !message
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
      input.setCustomValidity('请输入房间码。')
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
        const copying = navigator.clipboard?.writeText(code) ?? Promise.reject()
        void copying.then(
          () => { if (session.code === code) copyMessage = '已复制房间码。' },
          () => { if (session.code === code) copyMessage = '无法复制，请手动选中房间码。' },
        ).finally(render)
      }
      break
    case 'leave': session.leave(); break
    case 'accept': session.answer(true, button?.dataset.requestId); break
    case 'reject': session.answer(false, button?.dataset.requestId); break
    case 'direct': session.retryDirect(); break
    case 'relay': session.relay(); break
    case 'ask':
      transfer?.requestUpgrade()
      copyMessage = '已通知发起方。'
      render()
      break
    case 'cancel': transfer?.cancel(); break
    case 'resend': if (session.phase === 'connected') transfer?.retry(); break
    case 'select': if (session.phase === 'connected') fileInput.click(); break
    case 'save':
      if (picker && transfer && session.phase === 'connected') {
        const name = transfer.view.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '接收的文件'
        void transfer.accept(async () => (await picker.call(window, { suggestedName: name })).createWritable())
      }
      break
  }
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  fileInput.value = ''
  if (!file || session.phase !== 'connected') return
  if (file.size <= MAX_FILE) copyMessage = ''
  session.transfer?.offer(file)
})

draw()
if (!supportIssue) session.connect()
