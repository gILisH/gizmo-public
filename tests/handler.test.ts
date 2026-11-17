import { describe, it, expect } from 'vitest'
import { FakeTransport } from '../src/transport/fake'
import { makeEchoHandler } from '../src/handler'
import type { InboundMessage } from '../src/transport/types'

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  id: 'M1', chatJid: '111@s.whatsapp.net', senderJid: '111@s.whatsapp.net',
  text: 'hello', ts: 1000, fromMe: false, ...over,
})

describe('echo handler', () => {
  it('echoes an inbound message back to its chat', async () => {
    const t = new FakeTransport()
    t.onMessage(makeEchoHandler(t))
    await t.inject(msg({ text: 'ping', chatJid: '222@s.whatsapp.net' }))
    expect(t.sent).toEqual([{ chatJid: '222@s.whatsapp.net', text: 'ping' }])
  })

  it('ignores messages sent by us (fromMe)', async () => {
    const t = new FakeTransport()
    t.onMessage(makeEchoHandler(t))
    await t.inject(msg({ fromMe: true }))
    expect(t.sent).toEqual([])
  })
})
