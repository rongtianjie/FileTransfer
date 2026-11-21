const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })

export function formatByteSize(bytes: number) {
  if (bytes >= 1e9) return `${amount.format(bytes / 1e9)} GB`
  if (bytes >= 1e6) return `${amount.format(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${amount.format(bytes / 1e3)} kB`
  return `${amount.format(bytes)} B`
}
