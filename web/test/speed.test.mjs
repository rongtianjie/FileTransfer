import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SpeedMeter, formatDuration, formatSpeed } from '../src/speed.ts'

test('rate needs a second of data and uses a rolling window', () => {
  const meter = new SpeedMeter()
  meter.add(0, 0)
  assert.equal(meter.rate(500), undefined)
  meter.add(1_000_000, 1_000)
  assert.equal(meter.rate(1_000), 1_000_000)
  meter.add(2_000_000, 2_000)
  meter.add(3_000_000, 3_000)
  meter.add(4_000_000, 4_000)
  meter.add(5_000_000, 5_000)
  meter.add(5_100_000, 6_000)
  // The window now starts after the fast period, so the slowdown shows up.
  assert.ok(meter.rate(6_000) < 1_000_000)
})

test('a stalled transfer decays toward zero instead of freezing the last rate', () => {
  const meter = new SpeedMeter()
  meter.add(0, 0)
  meter.add(1_000_000, 1_000)
  const fast = meter.rate(1_000)
  assert.ok(meter.rate(10_000) < fast / 5)
})

test('a restart or smaller byte count clears the history', () => {
  const meter = new SpeedMeter()
  meter.add(0, 0)
  meter.add(1_000_000, 2_000)
  meter.add(10, 3_000)
  assert.equal(meter.rate(3_500), undefined)
})

test('durations and speed text are compact', () => {
  assert.equal(formatDuration(0.2), '1 秒')
  assert.equal(formatDuration(75), '1 分 15 秒')
  assert.equal(formatDuration(3_700), '1 小时 1 分')
  assert.equal(formatSpeed(undefined, 10), '')
  assert.equal(formatSpeed(2_000_000, 0), '2 MB/s')
  assert.equal(formatSpeed(1_000_000, 30_000_000), '1 MB/s · 剩余约 30 秒')
})
