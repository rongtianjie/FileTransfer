import { seriesRuns, type HistoryDay } from './model.ts'

const series = [
  { field: 'public', lightColor: '#2456bd', darkColor: '#5287f4', dash: [] },
  { field: 'reserved', lightColor: '#8a3e82', darkColor: '#c26db7', dash: [4, 4] },
] as const

const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
const short = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('zh-CN')

export function formatBytes(bytes: number) {
  const unit = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(bytes, 1)) / 10))
  return `${short.format(bytes / 1024 ** unit)} ${units[unit]}`
}

export function exactBytes(bytes: number | null) {
  return bytes === null ? '无数据' : `${integer.format(bytes)} B`
}

export function chartGeometry(width: number, height: number, count: number) {
  const left = 68
  const right = width - 10
  const bottom = height - 30
  return {
    left, right, bottom,
    x: (index: number) => count === 1 ? (left + right) / 2 : left + (right - left) * index / (count - 1),
    index: (x: number) => Math.max(0, Math.min(count - 1, Math.round((x - left) / (right - left) * (count - 1)))),
  }
}

export function drawTraffic(canvas: HTMLCanvasElement, history: HistoryDay[], selected: number) {
  const { clientWidth: width, clientHeight: height } = canvas
  if (!width || !height || !history.length) return
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(ratio, ratio)
  const { left, right, bottom, x } = chartGeometry(width, height, history.length)
  const top = 12
  const largest = Math.max(0, ...history.flatMap(day => [day.public ?? 0, day.reserved ?? 0]))
  const step = Math.max(1, 2 ** Math.ceil(Math.log2(largest / 4)))
  const ticks = largest ? 4 : 0
  const y = (bytes: number) => bottom - bytes * (bottom - top) / (step * 4)

  const isDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  ctx.font = '12px system-ui'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'right'
  ctx.fillStyle = isDark ? '#8a9bb5' : '#4b5973'
  ctx.strokeStyle = isDark ? '#202d45' : '#dbe3ef'
  for (let tick = 0; tick <= ticks; tick++) {
    const bytes = tick * step
    const lineY = y(bytes)
    ctx.beginPath()
    ctx.moveTo(left, lineY)
    ctx.lineTo(right, lineY)
    ctx.stroke()
    ctx.fillText(formatBytes(bytes), left - 8, lineY)
  }

  const lastIndex = history.length - 1
  const labels = lastIndex > 1 && width >= 420 ? [0, Math.floor(lastIndex / 2), lastIndex] : [0, lastIndex]
  for (const index of new Set(labels)) {
    ctx.textAlign = lastIndex === 0 ? 'center' : index === 0 ? 'left' : index === lastIndex ? 'right' : 'center'
    ctx.fillText(history[index].day.slice(5), x(index), bottom + 17)
  }

  ctx.strokeStyle = isDark ? '#4b6187' : '#788cae'
  ctx.beginPath()
  ctx.moveTo(x(selected), top)
  ctx.lineTo(x(selected), bottom)
  ctx.stroke()

  for (const item of series) {
    const { field, dash } = item
    const color = isDark ? item.darkColor : item.lightColor
    ctx.strokeStyle = color
    ctx.fillStyle = color
    const runs = seriesRuns(history.map(day => day[field]))
    for (const run of runs) {
      ctx.lineWidth = field === 'public' ? 3 : 2
      ctx.setLineDash([...dash])
      ctx.beginPath()
      for (const { index, bytes } of run) ctx.lineTo(x(index), y(bytes))
      ctx.stroke()
      ctx.setLineDash([])
      for (const { index, bytes } of run) {
        if (run.length !== 1 && index !== selected) continue
        ctx.beginPath()
        ctx.arc(x(index), y(bytes), field === 'public' ? 4.5 : 3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}
