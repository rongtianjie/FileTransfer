export type KeyAction = 'keep' | 'replace' | 'clear'
export type ConfigBaseline = { publicLimit: number; reservedLimit: number; keyVersion: number }
export type Quota = { used: number; limit: number; remaining: number }
export type HistoryDay = { day: string; timeZone?: string; public: number | null; reserved: number | null }
export type Dashboard = {
  turnEnabled: boolean
  ledgerFailed: boolean
  timeZone: string
  pendingTimeZone?: string
  timeZoneEffectiveAt?: string
  public: Quota
  reserved: Quota
  history: HistoryDay[]
  rooms: { active: number; direct: number; relay: number; failures: Record<string, number> }
  keyConfigured: boolean
  keyVersion: number
}

export type TimeZoneCancellation = {
  action: 'cancel'
  expectedPendingTimeZone: string
  expectedTimeZoneEffectiveAt: string
}

export function cancelTimeZonePayload({
  pendingTimeZone, timeZoneEffectiveAt,
}: Pick<Dashboard, 'pendingTimeZone' | 'timeZoneEffectiveAt'>): TimeZoneCancellation | null {
  if (!pendingTimeZone || !timeZoneEffectiveAt) return null
  return {
    action: 'cancel',
    expectedPendingTimeZone: pendingTimeZone,
    expectedTimeZoneEffectiveAt: timeZoneEffectiveAt,
  }
}

const maxBytes = 1024 ** 5

function readLimit(raw: string, label: string) {
  const bytes = Number(raw)
  if (!/^\d+$/.test(raw) || bytes > maxBytes) {
    throw new RangeError(`${label}须为 0 到 1 PiB 之间的整数字节数。`)
  }
  return bytes
}

export function configPayload(publicInput: string, reservedInput: string, keyAction: KeyAction, key: string, baseline: ConfigBaseline) {
  const publicLimit = readLimit(publicInput, '公共额度')
  const reservedLimit = readLimit(reservedInput, '保留额度')
  if (keyAction === 'replace' && (!key.trim() || new TextEncoder().encode(key).length > 512)) {
    throw new RangeError('请输入 1 到 512 字节的中继密钥。')
  }
  const expected: Partial<ConfigBaseline> = {}
  const changes: { publicLimit?: number; reservedLimit?: number; keyAction?: KeyAction; key?: string } = {}
  if (publicLimit !== baseline.publicLimit) {
    changes.publicLimit = publicLimit
    expected.publicLimit = baseline.publicLimit
  }
  if (reservedLimit !== baseline.reservedLimit) {
    changes.reservedLimit = reservedLimit
    expected.reservedLimit = baseline.reservedLimit
  }
  if (keyAction !== 'keep') {
    changes.keyAction = keyAction
    expected.keyVersion = baseline.keyVersion
  }
  if (keyAction === 'replace') changes.key = key
  return Object.keys(changes).length ? { ...changes, expected } : null
}

export function seriesRuns(values: (number | null)[]) {
  const runs: { index: number; bytes: number }[][] = []
  for (const [index, bytes] of values.entries()) {
    if (bytes === null) continue
    if (index === 0 || values[index - 1] === null) runs.push([])
    runs.at(-1)?.push({ index, bytes })
  }
  return runs
}

export class AdminError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function adminRequest<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  if (response.status === 204) return undefined as T
  if (response.ok) return response.json()
  const body = await response.json().catch(() => null)
  throw new AdminError(
    response.status,
    typeof body?.error === 'string' && body.error ? body.error : `请求失败（HTTP ${response.status}）。`,
  )
}

export function adminLogin(username: string, password: string) {
  return adminRequest<void>(fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }))
}
