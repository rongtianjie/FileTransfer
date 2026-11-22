import { adminLogin, AdminError } from './model.ts'
import { formatByteSize } from '../byte-size.ts'

type EntryState = 'signed-in' | 'signed-out' | 'hidden' | 'retry'

function adminEntryState(status: number | undefined): EntryState | undefined {
  if (status === 204) return 'signed-in'
  if (status === 401) return 'signed-out'
  if (status === 404) return 'hidden'
}

export function mountAdminEntry(container: HTMLElement, totals?: HTMLElement) {
  container.hidden = true
  container.innerHTML = `
    <button class="admin-entry-action tip-trigger" type="button" aria-describedby="home-admin-entry-tip">
      <span>管理后台</span>
      <span class="tip-bubble" id="home-admin-entry-tip" role="tooltip">登录并管理中继配额</span>
    </button>
    <button class="admin-entry-action tip-trigger" type="button" aria-haspopup="dialog" hidden>
      <span>中继配置</span>
      <span class="tip-bubble" role="tooltip">查看流量概览与调整配置</span>
    </button>
    <dialog class="admin-console" aria-label="中继配置">
      <div class="admin-console-bar">
        <span>中继配置</span>
        <button class="secondary" type="button" aria-label="关闭中继配置">关闭</button>
      </div>
    </dialog>
    <dialog class="admin-login" aria-labelledby="home-admin-title">
      <form method="dialog">
        <h2 id="home-admin-title">管理员登录</h2>
        <label for="home-admin-user">用户名</label>
        <input id="home-admin-user" name="username" autocomplete="username" required autofocus>
        <label for="home-admin-password">密码</label>
        <input id="home-admin-password" name="password" type="password" autocomplete="current-password" required>
        <p class="notice" role="status" hidden></p>
        <div class="admin-login-actions">
          <button class="secondary" type="button">取消</button>
          <button class="primary" type="submit">登录</button>
        </div>
      </form>
    </dialog>
  `
  const open = container.querySelector<HTMLButtonElement>(':scope > button')!
  const openLabel = open.querySelector('span')!
  const openTooltip = open.querySelector('[role="tooltip"]')!
  const config = container.querySelector<HTMLButtonElement>(':scope > button:nth-of-type(2)')!
  const consoleDialog = container.querySelector<HTMLDialogElement>('.admin-console')!
  const consoleClose = consoleDialog.querySelector('button')!
  const dialog = container.querySelector<HTMLDialogElement>('.admin-login')!
  const form = dialog.querySelector('form')!
  const username = form.querySelector<HTMLInputElement>('[name="username"]')!
  const password = form.querySelector<HTMLInputElement>('[name="password"]')!
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const cancel = form.querySelector<HTMLButtonElement>('button[type="button"]')!
  const notice = form.querySelector<HTMLElement>('[role="status"]')!
  let revision = 0
  let state: EntryState | undefined
  let adminProof: string | undefined
  let totalsRevision = 0

  function render(next: EntryState) {
    state = next
    const retrying = state === 'retry'
    const label = retrying ? '重试管理后台' : '管理后台'
    openLabel.textContent = label
    openTooltip.textContent = retrying ? '重新检查管理后台是否可用' : '登录并管理中继配额'
    open.setAttribute('aria-label', label)
    if (state === 'signed-out') open.setAttribute('aria-haspopup', 'dialog')
    else open.removeAttribute('aria-haspopup')
    open.hidden = state !== 'signed-out' && !retrying
    config.hidden = state !== 'signed-in'
    if (state !== 'signed-in' && consoleDialog.open) consoleDialog.close()
    container.hidden = state === 'hidden'
    if (totals) {
      totals.hidden = state !== 'signed-in'
      if (totals.hidden) {
        totals.textContent = ''
        totalsRevision++
      } else {
        void refreshTotals()
      }
    }
  }

  async function refreshTotals() {
    if (!totals || state !== 'signed-in') return
    const request = ++totalsRevision
    try {
      const response = await fetch('/api/admin/relay-totals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminProof }),
      })
      if (request !== totalsRevision) return
      if (response.status === 401) {
        render('signed-out')
        return
      }
      if (!response.ok) throw new Error('Relay totals unavailable')
      const { today, month } = await response.json() as { today: number; month: number }
      if (request === totalsRevision) {
        totals.textContent = `今日中继 ${formatByteSize(today)} · 本月中继 ${formatByteSize(month)}`
      }
    } catch {
      if (request === totalsRevision) totals.textContent = '中继流量暂不可用'
    }
  }

  async function refresh(retry = true, initiatedByButton = false) {
    if (dialog.open) return
    const request = ++revision
    const response = await fetch('/api/admin/session').catch(() => undefined)
    if (request !== revision) return
    const next = adminEntryState(response?.status)
    if (next) {
      render(next)
      if (initiatedByButton && next === 'signed-in') config.focus()
    } else if (retry) {
      window.setTimeout(() => {
        if (request === revision) void refresh(false)
      }, 1000)
    } else if (!state || state === 'hidden') {
      render('retry')
    }
  }

  function showNotice(text: string) {
    notice.textContent = text
    notice.hidden = text === ''
  }

  open.addEventListener('click', () => {
    if (state === 'retry') {
      void refresh(false, true)
      return
    }
    revision++
    showNotice('')
    dialog.showModal()
  })
  // The console lives in an iframe inside a non-modal floating dialog, so the
  // homepage (and any running transfer) keeps its state while it is open.
  function openConsole() {
    if (!consoleDialog.querySelector('iframe')) {
      const frame = document.createElement('iframe')
      frame.src = '/admin/'
      frame.title = '中继配置'
      consoleDialog.append(frame)
    }
    if (!consoleDialog.open) consoleDialog.show()
    consoleDialog.querySelector('iframe')!.focus()
  }
  config.addEventListener('click', openConsole)
  consoleClose.addEventListener('click', () => consoleDialog.close())
  consoleDialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') consoleDialog.close()
  })
  consoleDialog.addEventListener('close', () => {
    consoleDialog.querySelector('iframe')?.remove()
    void refresh()
    config.focus()
  })
  cancel.addEventListener('click', () => dialog.close())
  dialog.addEventListener('cancel', event => {
    if (submit.disabled) event.preventDefault()
  })
  dialog.addEventListener('close', () => {
    password.value = ''
  })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    event.stopPropagation()
    if (submit.disabled) return
    submit.disabled = cancel.disabled = true
    username.readOnly = password.readOnly = true
    showNotice('正在登录…')
    try {
      await adminLogin(username.value, password.value)
      dialog.close()
      render('signed-in')
      config.focus()
    } catch (error) {
      showNotice(error instanceof AdminError ? error.message : '暂时无法登录，请重试。')
      password.focus()
    } finally {
      password.value = ''
      username.readOnly = password.readOnly = false
      submit.disabled = cancel.disabled = false
    }
  })

  window.addEventListener('pageshow', () => void refresh())
  window.addEventListener('focus', () => void refresh())
  if (totals) {
    window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshTotals()
    }, 15_000)
  }
  void refresh()
  return (proof: string | undefined) => {
    if (proof === adminProof) return
    adminProof = proof
    void refreshTotals()
  }
}
