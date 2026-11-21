import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, iceConfig, usesRelay } from '../src/session.ts'

test('direct config strips TURN and credentials, while relay forces TURN', () => {
  const config = [{ urls: ['stun:direct', 'turn:relay', 'turns:relay'], username: 'u', credential: 'p' }]
  assert.deepEqual(iceConfig('direct', config), {
    iceServers: [{ urls: ['stun:direct'] }],
    iceTransportPolicy: 'all',
  })
  assert.deepEqual(iceConfig('relay', config), {
    iceServers: [{ urls: ['turn:relay', 'turns:relay'], username: 'u', credential: 'p' }],
    iceTransportPolicy: 'relay',
  })
})

test('relay verification checks the selected pair rather than any gathered candidate', async () => {
  const stats = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local' }],
    ['local', { candidateType: 'host' }],
    ['unused', { candidateType: 'relay' }],
  ])
  const pc = { async getStats() { return stats } }
  assert.equal(await usesRelay(pc), false)
  stats.get('selected').localCandidateId = 'unused'
  assert.equal(await usesRelay(pc), true)
})

test('room approval, failure, keyed retry, and reconnect carry the expected token and epoch', () => {
  const sent = []
  class MockSocket {
    static OPEN = 1
    static current
    readyState = 1
    constructor() { MockSocket.current = this }
    send(data) { sent.push(JSON.parse(data)) }
    receive(data) { this.onmessage({ data: JSON.stringify(data) }) }
    close() { this.onclose() }
  }
  class MockPeer {
    close() {}
  }
  Object.defineProperty(globalThis, 'location', { value: { href: 'https://example.test/' } })
  globalThis.WebSocket = MockSocket
  globalThis.RTCPeerConnection = MockPeer
  const session = new Session(() => {})
  session.connect()
  const ws = MockSocket.current
  ws.onopen()
  ws.receive({ type: 'config', relayAvailable: true, keyAvailable: true })
  session.enter('host', '')
  assert.deepEqual(sent.at(-1), { type: 'create' })
  ws.receive({ type: 'created', code: '0421', token: 'own', expiresAt: 1000 })
  ws.receive({ type: 'request', requestId: 'old-request' })
  assert.equal(session.requestId, 'old-request')
  ws.receive({ type: 'waiting' })
  assert.equal(session.requestId, undefined)
  ws.receive({ type: 'request', requestId: 'new-request' })
  session.answer(true, 'old-request')
  assert.equal(sent.at(-1).type, 'create')
  session.answer(true, 'new-request')
  assert.deepEqual(sent.at(-1), { type: 'accept', requestId: 'new-request', token: 'own' })
  ws.receive({ type: 'start', epoch: 1, mode: 'direct', initiator: false })
  ws.receive({ type: 'failed', epoch: 0, mode: 'direct' })
  assert.equal(session.phase, 'connecting')
  ws.receive({ type: 'failed', epoch: 1, mode: 'direct', reason: 'connection_failed' })
  assert.equal(session.phase, 'failed')
  session.retryDirect()
  assert.deepEqual(sent.at(-1), { type: 'retry', token: 'own' })
  ws.receive({ type: 'start', epoch: 2, mode: 'direct', initiator: false, iceServers: [] })
  ws.receive({ type: 'failed', epoch: 2, mode: 'direct' })
  session.relay('key')
  assert.deepEqual(sent.at(-1), { type: 'relay', key: 'key', token: 'own' })
  ws.receive({ type: 'error', reason: 'invalid_key' })
  assert.match(session.message, /密钥无效/)
  assert.equal(session.busy, false)
  ws.close()
  assert.equal(session.phase, 'idle')
  assert.equal(session.socketState, 'offline')
  session.connect()
  assert.notEqual(MockSocket.current, ws)
  assert.deepEqual(sent.at(-1), { type: 'relay', key: 'key', token: 'own' })
})
