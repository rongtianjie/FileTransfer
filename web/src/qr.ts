import qrcode from 'qrcode-generator'

// Error level M tolerates a dirty or low-contrast screen while keeping the code small.
export function inviteQr(url: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
}

// A phone cannot reach the machine's own loopback address, so a code for it would only mislead.
export function inviteReachable(hostname: string) {
  return hostname !== 'localhost' && !hostname.endsWith('.localhost') && hostname !== '::1' && hostname !== '[::1]' &&
    !/^127\./.test(hostname)
}
