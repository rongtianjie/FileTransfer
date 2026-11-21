import { adminLogin, AdminError } from './model.ts'

type EntryState = 'signed-in' | 'signed-out' | 'hidden' | 'retry'

function adminEntryState(status: number | undefined): EntryState | undefined {
  if (status === 204) return 'signed-in'
  if (status === 401) return 'signed-out'
  if (status === 404) return 'hidden'
}

export function mountAdminEntry(container: HTMLElement) {
  container.hidden = true
  container.innerHTML = `
    <button class="admin-entry-action tip-trigger" type="button" aria-describedby="home-admin-entry-tip">
      <span>管理后台</span>
      <span class="tip-bubble" id="home-admin-entry-tip" role="tooltip">登录并管理中继配额</span>
    </button>
    <a class="admin-entry-action tip-trigger" href="/admin/" hidden>
      <span>中继配置</span>
      <span class="tip-bubble" role="tooltip">查看流量概览与调整配置</span>
    </a>
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
  const config = container.querySelector<HTMLAnchorElement>('a')!
  const dialog = container.querySelector('dialog')!
  const form = dialog.querySelector('form')!
  const username = form.querySelector<HTMLInputElement>('[name="username"]')!
  const password = form.querySelector<HTMLInputElement>('[name="password"]')!
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const cancel = form.querySelector<HTMLButtonElement>('button[type="button"]')!
  const notice = form.querySelector<HTMLElement>('[role="status"]')!
  let revision = 0
  let state: EntryState | undefined

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
    container.hidden = state === 'hidden'
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
  void refresh()
}
