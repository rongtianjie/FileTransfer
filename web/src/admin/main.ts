import './style.css'
import { adminLogin, AdminError, adminRequest, configPayload, type Dashboard, type HistoryDay, type KeyAction, type Quota } from './model.ts'
import { chartGeometry, drawTraffic, exactBytes, formatBytes } from './traffic.ts'

function element<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T
}

function message(error: unknown) {
  return error instanceof AdminError || error instanceof RangeError
    ? error.message
    : '无法读取服务器响应，请重试。'
}

type Days = 7 | 30 | 90
let days: Days = 30
let history: HistoryDay[] = []
let busy = false
let configDirty = false
const failureLabels = new Map([
  ['connection_failed', '设备连接失败'],
  ['session_quota', '免密中继额度耗尽'],
  ['global_quota', '每日中继额度耗尽'],
  ['relay_expired', '中继授权过期'],
])

const pageStatus = element('page-status')
const loginView = element('login-view')
const loginForm = element<HTMLFormElement>('login-form')
const username = element<HTMLInputElement>('username')
const password = element<HTMLInputElement>('password')
const loginStatus = element('login-status')
const dashboardView = element('dashboard')
const nav = element('admin-nav')
const retry = element<HTMLButtonElement>('retry')
const refresh = element<HTMLButtonElement>('refresh')
const logout = element<HTMLButtonElement>('logout')
const historyStatus = element('history-status')
const rangeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#range button'))
const dateSelect = element<HTMLSelectElement>('history-date')
const previousDate = element<HTMLButtonElement>('previous-date')
const nextDate = element<HTMLButtonElement>('next-date')
const chart = element<HTMLCanvasElement>('chart')
const settingsForm = element<HTMLFormElement>('settings-form')
const publicLimit = element<HTMLInputElement>('public-limit')
const reservedLimit = element<HTMLInputElement>('reserved-limit')
const keyAction = element<HTMLSelectElement>('key-action')
const keyInput = element<HTMLInputElement>('new-key')
const settingsStatus = element('settings-status')
const settlementStatus = element('settlement-status')
const useBrowserZone = element<HTMLButtonElement>('use-browser-zone')
const useShanghaiZone = element<HTMLButtonElement>('use-shanghai-zone')
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const shanghaiZone = 'Asia/Shanghai'

async function run(action: () => Promise<void>) {
  if (busy) return
  busy = true
  const buttons = [retry, refresh, logout, ...rangeButtons, element('login-submit'), element('save'), useBrowserZone, useShanghaiZone]
  buttons.forEach(button => button.setAttribute('aria-disabled', 'true'))
  try {
    await action()
  } finally {
    busy = false
    buttons.forEach(button => button.removeAttribute('aria-disabled'))
  }
}

function resetKey() {
  keyAction.value = 'keep'
  updateKeyField()
}

function updateKeyField() {
  const replacing = keyAction.value === 'replace'
  element('new-key-field').hidden = !replacing
  keyInput.disabled = !replacing
  keyInput.required = replacing
  if (!replacing) keyInput.value = ''
}

function showLogin(notice = '') {
  days = 30
  history = []
  dateSelect.replaceChildren()
  configDirty = false
  settingsForm.reset()
  settingsStatus.textContent = ''
  settlementStatus.textContent = ''
  historyStatus.textContent = ''
  resetKey()
  nav.hidden = true
  dashboardView.hidden = true
  retry.hidden = true
  pageStatus.textContent = ''
  loginView.hidden = false
  password.value = ''
  loginStatus.textContent = notice
  username.focus()
}

function needsLogin(error: unknown) {
  if (!(error instanceof AdminError) || error.status !== 401) return false
  showLogin('请登录以继续。')
  return true
}

function quotaPanel(label: string, quota: Quota, series: string) {
  const card = document.createElement('div')
  card.className = `quota ${series}-series`
  const over = quota.used > quota.limit
  const ratio = quota.limit > 0 ? Math.min(1, quota.used / quota.limit) : Number(over)
  card.innerHTML = `
    <h3></h3>
    <strong class="amount"></strong>
    <span class="amount-label">已用</span>
    <div class="quota-track" aria-hidden="true"><span></span></div>
    <dl><div><dt>上限</dt><dd></dd></div><div><dt>剩余</dt><dd></dd></div></dl>
    <p class="overage"></p>
  `
  card.querySelector('h3')!.textContent = label
  const amount = card.querySelector('.amount')!
  amount.textContent = formatBytes(quota.used)
  amount.setAttribute('title', exactBytes(quota.used))
  card.querySelector<HTMLElement>('.quota-track span')!.style.width = `${ratio * 100}%`
  const [limit, remaining] = card.querySelectorAll('dd')
  limit.textContent = exactBytes(quota.limit)
  remaining.textContent = exactBytes(quota.remaining)
  card.querySelector('.overage')!.textContent = over ? `超出额度 ${exactBytes(quota.used - quota.limit)}` : ''
  return card
}

function renderDashboard(data: Dashboard) {
  const relayStatus = element('relay-status')
  relayStatus.textContent = data.turnEnabled ? '中继已启用' : '中继已关闭'
  relayStatus.dataset.enabled = String(data.turnEnabled)
  element('ledger-status').textContent = data.ledgerFailed ? '流量账本异常，中继转发已暂停。' : ''
  element('quotas').replaceChildren(
    quotaPanel('公共额度', data.public, 'public'),
    quotaPanel('保留额度', data.reserved, 'reserved'),
  )
  for (const field of ['active', 'direct', 'relay'] as const) {
    element(`rooms-${field}`).textContent = data.rooms[field].toLocaleString('zh-CN')
  }

  const failures = Object.entries(data.rooms.failures).sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
  element('failures').replaceChildren(...failures.map(([reason, count]) => {
    const row = document.createElement('div')
    const label = document.createElement('dt')
    const total = document.createElement('dd')
    label.textContent = failureLabels.get(reason) ?? reason
    total.textContent = count.toLocaleString('zh-CN')
    row.append(label, total)
    return row
  }))
  element('no-failures').hidden = failures.length > 0

  element('key-state').textContent = data.keyConfigured ? '密钥已设置' : '尚未设置密钥'
  if (!configDirty) {
    publicLimit.value = String(data.public.limit)
    reservedLimit.value = String(data.reserved.limit)
  }
  renderSettlement(data)
  renderHistory(data.history)
}

function renderSettlement(data: Dashboard) {
  const zone = data.timeZone
  const target = data.pendingTimeZone
  const pending = element('settlement-pending')
  element('quota-title').textContent = target ? '本期额度' : '今日额度'
  element('quota-time-zone').textContent = `按 ${zone} 结算`
  element('settlement-current').textContent = `当前使用 ${zone}，两类额度共享此时区。`
  pending.hidden = !target
  if (target && data.timeZoneEffectiveAt) {
    const instant = new Date(data.timeZoneEffectiveAt)
    let stamp = instant.toISOString()
    try {
      stamp = new Intl.DateTimeFormat('zh-CN', {
        timeZone: target, dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23',
      }).format(instant)
    } catch {
      // A browser can lack a zone identifier supported by the server.
    }
    pending.textContent = `将于 ${stamp}（${target}）切换，当前额度届时结算。`
  }
  useBrowserZone.hidden = !browserZone || browserZone === (target ?? zone)
  useBrowserZone.textContent = `使用浏览器时区（${browserZone}）`
  useShanghaiZone.hidden = shanghaiZone === (target ?? zone) || browserZone === shanghaiZone
}

function renderHistory(rows: HistoryDay[]) {
  const previousDate = dateSelect.selectedOptions[0]?.textContent
  history = [...rows].sort((a, b) => a.day.localeCompare(b.day))
  const hasTrafficData = history.some(row => row.public !== null || row.reserved !== null)
  element('plot').hidden = !hasTrafficData
  element('date-readout').hidden = !history.length
  historyStatus.textContent = hasTrafficData ? '' : '该周期暂无流量记录。'
  dateSelect.replaceChildren(...history.map((row, index) => new Option(row.day, String(index))))
  const previousIndex = history.findIndex(row => row.day === previousDate)
  dateSelect.selectedIndex = previousIndex >= 0 ? previousIndex : history.length - 1
  renderSelection()
}

function renderSelection() {
  const row = history[dateSelect.selectedIndex]
  if (!row) return
  previousDate.setAttribute('aria-disabled', String(dateSelect.selectedIndex === 0))
  nextDate.setAttribute('aria-disabled', String(dateSelect.selectedIndex === history.length - 1))
  element('history-zone-row').hidden = !row.timeZone
  element('history-zone').textContent = row.timeZone ?? ''
  element('history-public').textContent = exactBytes(row.public)
  element('history-reserved').textContent = exactBytes(row.reserved)
  drawTraffic(chart, history, dateSelect.selectedIndex)
}

async function loadDashboard(period = days) {
  const data = await adminRequest<Dashboard>(fetch(`/api/admin/dashboard?days=${period}`))
  days = period
  pageStatus.textContent = ''
  retry.hidden = true
  loginView.hidden = true
  nav.hidden = false
  dashboardView.hidden = false
  rangeButtons.forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.days) === days)))
  renderDashboard(data)
}

async function openDashboard(focusHeading = false) {
  pageStatus.textContent = '正在读取运行数据…'
  try {
    await loadDashboard()
    if (focusHeading) element('dashboard-title').focus()
  } catch (error) {
    if (error instanceof AdminError && error.status === 401) {
      showLogin()
    } else {
      pageStatus.textContent = message(error)
      retry.hidden = false
      retry.focus()
    }
  }
}

function write(method: 'POST' | 'PUT', endpoint: string, body?: object) {
  return adminRequest<void>(fetch(`/api/admin/${endpoint}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }))
}

loginForm.addEventListener('submit', event => {
  event.preventDefault()
  void run(async () => {
    loginStatus.textContent = '正在登录…'
    password.readOnly = true
    username.readOnly = true
    try {
      await adminLogin(username.value, password.value)
      loginStatus.textContent = ''
      loginView.hidden = true
      await openDashboard(true)
    } catch (error) {
      loginStatus.textContent = message(error)
      password.focus()
    } finally {
      username.readOnly = false
      password.readOnly = false
      password.value = ''
    }
  })
})

logout.addEventListener('click', () => void run(async () => {
  pageStatus.textContent = '正在退出…'
  try {
    await write('POST', 'logout')
    showLogin('已退出登录。')
  } catch (error) {
    if (!needsLogin(error)) pageStatus.textContent = message(error)
  }
}))

retry.addEventListener('click', () => void run(() => openDashboard(true)))
refresh.addEventListener('click', () => void run(async () => {
  pageStatus.textContent = '正在刷新…'
  try {
    await loadDashboard()
    pageStatus.textContent = '数据已刷新。'
  } catch (error) {
    if (!needsLogin(error)) pageStatus.textContent = message(error)
  }
}))

for (const button of rangeButtons) {
  button.addEventListener('click', () => void run(async () => {
    const period = Number(button.dataset.days) as Days
    if (period === days) return
    historyStatus.textContent = '正在读取该周期的流量数据…'
    try {
      await loadDashboard(period)
      if (history.some(row => row.public !== null || row.reserved !== null)) {
        historyStatus.textContent = `已显示最近 ${days} 天。`
      }
    } catch (error) {
      if (!needsLogin(error)) historyStatus.textContent = message(error)
    }
  }))
}

dateSelect.addEventListener('change', renderSelection)
function stepDate(offset: number) {
  const index = dateSelect.selectedIndex + offset
  if (index < 0 || index >= history.length) return
  dateSelect.selectedIndex = index
  renderSelection()
}
previousDate.addEventListener('click', () => stepDate(-1))
nextDate.addEventListener('click', () => stepDate(1))
chart.addEventListener('click', event => {
  const rect = chart.getBoundingClientRect()
  dateSelect.selectedIndex = chartGeometry(chart.clientWidth, chart.clientHeight, history.length).index(event.clientX - rect.left)
  renderSelection()
})
new ResizeObserver(renderSelection).observe(chart)
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderSelection)
}

settingsForm.addEventListener('input', () => { configDirty = true })
keyAction.addEventListener('change', updateKeyField)
settingsForm.addEventListener('submit', event => {
  event.preventDefault()
  void run(async () => {
    const fields = [publicLimit, reservedLimit, keyInput]
    let saved = false
    try {
      const payload = configPayload(publicLimit.value, reservedLimit.value, keyAction.value as KeyAction, keyInput.value)
      fields.forEach(field => { field.readOnly = true })
      keyAction.disabled = true
      settingsStatus.textContent = '正在保存设置…'
      await write('PUT', 'config', payload)
      saved = true
      configDirty = false
      resetKey()
      await loadDashboard()
      settingsStatus.textContent = '设置已保存。'
    } catch (error) {
      if (!needsLogin(error)) {
        settingsStatus.textContent = saved ? `设置已保存。刷新数据时出错。 ${message(error)}` : message(error)
      }
    } finally {
      fields.forEach(field => { field.readOnly = false })
      keyAction.disabled = false
    }
  })
})

function saveTimeZone(timeZone: string) {
  void run(async () => {
    let saved = false
    settlementStatus.textContent = '正在保存时区…'
    try {
      await write('PUT', 'time-zone', { timeZone })
      saved = true
      await loadDashboard()
      settlementStatus.textContent = '时区设置已保存。'
    } catch (error) {
      if (!needsLogin(error)) {
        settlementStatus.textContent = saved ? `时区设置已保存。刷新数据时出错。 ${message(error)}` : message(error)
      }
    }
  })
}

useBrowserZone.addEventListener('click', () => saveTimeZone(browserZone))
useShanghaiZone.addEventListener('click', () => saveTimeZone(shanghaiZone))
void run(() => openDashboard())
