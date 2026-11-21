import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, iceConfig, usesRelay } from '../src/session.ts'

Object.defineProperty(globalThis, 'location', { value: { href: 'https://example.test/' } })

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
  ws.send = () => { throw new Error('cannot submit fallback') }
  session.relay('key')
  assert.equal(session.busy, false)
  assert.match(session.message, /会话服务不可用/)
  ws.close()
  assert.equal(session.phase, 'idle')
  assert.equal(session.socketState, 'offline')
  session.connect()
  assert.notEqual(MockSocket.current, ws)
  assert.deepEqual(sent.at(-1), { type: 'relay', key: 'key', token: 'own' })
})

async function relayRoom(t) {
  const sockets = []
  const channels = []
  class MockSocket {
    static OPEN = 1
    readyState = 1
    sent = []
    constructor() { sockets.push(this) }
    send(data) { this.sent.push(JSON.parse(data)) }
    receive(data) { this.onmessage({ data: JSON.stringify(data) }) }
  }
  class MockPeer {
    constructor() { this.channel = channels.shift() }
    connectionState = 'connected'
    sctp = { transport: { iceTransport: { getSelectedCandidatePair: () => ({ local: { type: 'relay' } }) } } }
    createDataChannel() { return this.channel }
    async createOffer() { return { type: 'offer' } }
    async setLocalDescription() {}
    close() {}
  }
  globalThis.WebSocket = MockSocket
  globalThis.RTCPeerConnection = MockPeer
  const host = new Session(() => {})
  const guest = new Session(() => {})
  const delivery = []
  const flush = () => { while (delivery.length) delivery.shift()() }
  const start = async (epoch, authorized = false, connecting = () => {}) => {
    const channel = () => ({
      label: 'file-transfer',
      readyState: 'connecting',
      bufferedAmount: 0,
      send(data) { delivery.push(() => this.other.onmessage?.({ data })) },
      close() {
        if (this.readyState === 'closed') return
        this.readyState = this.other.readyState = 'closed'
        delivery.push(() => { this.onclose?.(); this.other.onclose?.() })
      },
    })
    const left = channel()
    const right = channel()
    left.other = right
    right.other = left
    channels.push(left, right)
    for (const [index, ws] of sockets.entries()) {
      ws.receive({ type: 'start', epoch, initiator: index === 0, mode: 'relay', remaining: 128, authorized })
    }
    guest.attempt.pc.ondatachannel({ channel: right })
    connecting()
    for (const channel of [left, right]) {
      channel.readyState = 'open'
      channel.onopen()
    }
    await Promise.resolve()
  }
  t.after(() => { host.leave(); guest.leave() })
  for (const [index, session] of [host, guest].entries()) {
    session.connect()
    const ws = sockets[index]
    ws.onopen()
    ws.receive({ type: 'config', relayAvailable: true, keyAvailable: true })
    session.enter(index === 0 ? 'host' : 'guest', '0421')
    ws.receive(index === 0
      ? { type: 'created', code: '0421', token: 'host', expiresAt: 1000 }
      : { type: 'joined', token: 'guest' })
  }
  await start(1)
  const large = new File([new Uint8Array(129)], 'large.bin')
  assert.equal(host.transfer.offer(large), false)
  return { host, guest, flush, start, ws: sockets[0] }
}

test('relay upgrade defers to a pending offer or save on either peer, including a crossed guest offer', async t => {
  const { host, guest, flush, ws } = await relayRoom(t)
  const small = new File([], 'small.bin')
  const requested = () => ws.sent.some(msg => ['relay_upgrade', 'relay'].includes(msg.type))

  guest.transfer.offer(small)
  host.relay('key')
  assert.equal(requested(), false)
  flush()
  assert.equal(requested(), false)
  assert.equal(guest.transfer.view.phase, 'waiting')
  assert.equal(host.transfer.view.phase, 'offered')
  host.transfer.cancel()
  flush()

  host.transfer.offer(small)
  flush()
  host.relay('key')
  assert.equal(requested(), false)
  let openWriter
  const picking = guest.transfer.accept(() => new Promise(resolve => { openWriter = resolve }))
  host.relay('key')
  assert.equal(requested(), false)
  let closeWriter
  const closing = new Promise(resolve => { closeWriter = resolve })
  openWriter({ close: () => closing, async abort() {} })
  await picking
  flush()
  await Promise.resolve()
  assert.equal(guest.transfer.view.phase, 'saving')
  assert.equal(host.transfer.view.phase, 'confirming')
  host.relay('key')
  assert.equal(requested(), false)
  closeWriter()
  await Promise.resolve()
  flush()
  assert.equal(host.transfer.view.phase, 'done')
  host.relay('key')
  flush()
  assert.equal(requested(), true)
})

test('both peers block new offers through relay reservation and server response, then release on error', async t => {
  const { host, guest, flush, start, ws } = await relayRoom(t)
  const small = new File([], 'small.bin')
  host.relay('wrong')
  assert.equal(host.transfer.offer(small), false)
  assert.equal(ws.sent.some(msg => ['relay_upgrade', 'relay'].includes(msg.type)), false)
  flush()
  assert.deepEqual(ws.sent.at(-1), { type: 'relay_upgrade', token: 'host', key: 'wrong', epoch: 1 })
  assert.equal(guest.transfer.offer(small), false)
  ws.receive({ type: 'error', reason: 'invalid_key' })
  flush()
  assert.equal(host.transfer.canOffer, true)
  assert.equal(guest.transfer.canOffer, true)

  host.relay('key')
  flush()
  assert.equal(host.transfer.offer(small), false)
  assert.equal(guest.transfer.offer(small), false)
  await start(2, true, () => {
    assert.equal(host.phase, 'connecting')
    assert.equal(guest.phase, 'connecting')
    assert.equal(host.transfer.canOffer, false)
    assert.equal(guest.transfer.canOffer, false)
  })
  assert.equal(host.phase, 'connected')
  assert.equal(guest.phase, 'connected')
  assert.equal(guest.transfer.offer(small), true)
  flush()
  assert.equal(host.transfer.view.phase, 'offered')
})

test('a peer without relay reservation support times out without sending the key to the server', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, guest, flush, ws } = await relayRoom(t)
  const channel = guest.attempt.channel
  const receive = channel.onmessage
  channel.onmessage = event => {
    if (!JSON.parse(event.data).type.startsWith('relay-')) receive(event)
  }
  host.relay('key')
  flush()
  t.mock.timers.tick(8_000)
  flush()
  assert.equal(ws.sent.some(msg => ['relay_upgrade', 'relay'].includes(msg.type)), false)
  assert.equal(host.transfer.canOffer, true)
  assert.equal(guest.transfer.canOffer, true)
  assert.match(host.message, /刷新/)
})

test('a detached disk close blocks the replacement receiver and reports the local result', async t => {
  const { host, guest, flush, start } = await relayRoom(t)
  const file = new File([], 'disk.txt')
  host.transfer.offer(file)
  flush()
  let closeWriter
  const closing = new Promise(resolve => { closeWriter = resolve })
  await guest.transfer.accept(async () => ({ close: () => closing, async abort() {} }))
  flush()
  await Promise.resolve()
  await start(2)
  assert.equal(host.unconfirmedSave.name, file.name)
  assert.equal(host.retryFile, undefined)
  assert.equal(guest.savingAfterDisconnect, true)
  assert.equal(guest.transfer.offer(file), false)
  assert.equal(host.transfer.offer(file), true)
  flush()
  assert.equal(guest.transfer.view.phase, 'idle')
  assert.equal(host.transfer.view.phase, 'stopped')
  closeWriter()
  await Promise.resolve()
  assert.equal(guest.savingAfterDisconnect, false)
  assert.deepEqual(guest.detachedSave, { name: file.name, saved: true })
  host.leave()
  guest.leave()
  assert.equal(host.unconfirmedSave.name, file.name)
  assert.deepEqual(guest.detachedSave, { name: file.name, saved: true })
})

test('failed relay sends roll back the reservation when neither peer committed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, guest, flush, ws } = await relayRoom(t)
  const left = host.attempt.channel
  const right = guest.attempt.channel
  const leftSend = left.send
  const rightSend = right.send
  left.send = () => { throw new Error('cannot queue prepare') }
  host.relay('key')
  assert.equal(host.busy, false)
  assert.equal(host.transfer.canOffer, true)
  assert.equal(guest.transfer.canOffer, true)

  left.send = leftSend
  right.send = () => { throw new Error('cannot queue ready') }
  host.relay('key')
  flush()
  assert.equal(host.busy, true)
  assert.equal(guest.transfer.canOffer, true)
  t.mock.timers.tick(8_000)
  flush()
  assert.equal(host.transfer.canOffer, true)

  right.send = rightSend
  ws.send = () => { throw new Error('cannot submit upgrade') }
  host.relay('key')
  flush()
  assert.equal(host.busy, false)
  assert.equal(host.transfer.canOffer, true)
  assert.equal(guest.transfer.canOffer, true)
  assert.equal(ws.sent.some(msg => ['relay_upgrade', 'relay'].includes(msg.type)), false)
})

test('the host closes the attempt if it cannot release a guest reservation', async t => {
  const { host, guest, flush, ws } = await relayRoom(t)
  host.relay('wrong')
  flush()
  const channel = host.attempt.channel
  channel.send = () => { throw new Error('cannot queue release') }
  ws.receive({ type: 'error', reason: 'invalid_key' })
  assert.equal(channel.readyState, 'closed')
  flush()
  assert.equal(host.phase, 'failed')
  assert.equal(host.busy, false)
  assert.equal(guest.phase, 'failed')
})

for (const saved of [true, false]) {
  test(`failed ${saved ? 'complete' : 'save_failed'} delivery closes the channel and preserves both save outcomes`, async t => {
    const { host, guest, flush } = await relayRoom(t)
    const file = new File([], 'disk.txt')
    const receiver = guest.transfer
    const channel = guest.attempt.channel
    const send = channel.send
    let stateAtSend
    let phaseAtClose
    const close = channel.close
    channel.close = function () {
      if (this.readyState === 'open') phaseAtClose = receiver.view.phase
      close.call(this)
    }
    channel.send = function (data) {
      const message = JSON.parse(data)
      if (saved ? message.type === 'complete' : message.reason === 'save_failed') {
        stateAtSend = this.readyState
        throw new Error('cannot queue final result')
      }
      send.call(this, data)
    }
    host.transfer.offer(file)
    flush()
    await guest.transfer.accept(async () => ({
      async close() { if (!saved) throw new Error('disk failure') },
      async abort() {},
    }))
    flush()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(stateAtSend, 'open')
    assert.equal(phaseAtClose, saved ? 'done' : 'stopped')
    assert.equal(channel.readyState, 'closed')
    flush()
    assert.equal(host.phase, 'failed')
    assert.equal(host.unconfirmedSave?.name, file.name)
    assert.equal(host.retryFile, undefined)
    assert.deepEqual(guest.detachedSave, { name: file.name, saved })
  })
}
