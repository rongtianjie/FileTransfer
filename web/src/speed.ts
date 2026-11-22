import { formatByteSize } from './byte-size.ts'

const SPAN = 4_000
const MIN_SPAN = 1_000

// Rolling-window throughput so the rate reacts to slowdowns but does not jitter per chunk.
export class SpeedMeter {
  private samples: { at: number; bytes: number }[] = []

  reset() {
    this.samples = []
  }

  add(bytes: number, at: number) {
    const last = this.samples.at(-1)
    if (last && (bytes < last.bytes || at < last.at)) this.samples = []
    if (!last || bytes !== last.bytes) this.samples.push({ at, bytes })
    while (this.samples.length > 2 && at - this.samples[1].at >= SPAN) this.samples.shift()
  }

  // Bytes per second, or undefined until at least a second of data exists.
  rate(now: number) {
    const first = this.samples[0]
    const last = this.samples.at(-1)
    if (!first || !last || last === first || now - first.at < MIN_SPAN) return undefined
    // A stalled transfer must read as slow, so measure up to now rather than the last sample.
    const rate = (last.bytes - first.bytes) / ((Math.max(now, last.at) - first.at) / 1000)
    return rate > 0 ? rate : undefined
  }
}

export function formatDuration(seconds: number) {
  const total = Math.max(1, Math.ceil(seconds))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

export function formatSpeed(rate: number | undefined, remaining: number) {
  if (rate === undefined) return ''
  const eta = remaining > 0 ? ` · 剩余约 ${formatDuration(remaining / rate)}` : ''
  return `${formatByteSize(rate)}/s${eta}`
}
