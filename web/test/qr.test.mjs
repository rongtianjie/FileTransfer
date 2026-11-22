import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inviteQr, inviteReachable } from '../src/qr.ts'

test('invite QR is a scalable SVG that depends on its input', () => {
  const svg = inviteQr('https://transfer.example.com/#0421')
  assert.match(svg, /^<svg/)
  assert.match(svg, /viewBox/)
  assert.notEqual(inviteQr('https://transfer.example.com/#0422'), svg)
})

test('loopback hosts do not get a QR code', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) assert.equal(inviteReachable(host), false, host)
  for (const host of ['transfer.example.com', '192.168.1.5', '10.0.0.2']) assert.equal(inviteReachable(host), true, host)
})
