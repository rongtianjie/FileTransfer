import { adminLogin, AdminError } from './model.ts'

export function mountAdminEntry(container: HTMLElement) {
  container.hidden = true
  container.innerHTML = `
    <button class="admin-entry-action" type="button" aria-haspopup="dialog">登录</button>
    <a class="admin-entry-action" href="/admin/" hidden>配置</a>
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
  const config = container.querySelector<HTMLAnchorElement>('a')!
  const dialog = container.querySelector('dialog')!
  const form = dialog.querySelector('form')!
  const username = form.querySelector<HTMLInputElement>('[name="username"]')!
  const password = form.querySelector<HTMLInputElement>('[name="password"]')!
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const cancel = form.querySelector<HTMLButtonElement>('button[type="button"]')!
  const notice = form.querySelector<HTMLElement>('[role="status"]')!
  let revision = 0

  function render(state: 'signed-in' | 'signed-out' | 'hidden') {
    open.hidden = state !== 'signed-out'
    config.hidden = state !== 'signed-in'
    container.hidden = state === 'hidden'
  }

  async function refresh() {
    if (dialog.open) return
    const request = ++revision
    try {
      const response = await fetch('/api/admin/session')
      if (request !== revision) return
      render(response.status === 204 ? 'signed-in' : response.status === 401 ? 'signed-out' : 'hidden')
    } catch {
      // A failed status check should leave the transfer page usable.
    }
  }

  function showNotice(text: string) {
    notice.textContent = text
    notice.hidden = text === ''
  }

  open.addEventListener('click', () => {
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
