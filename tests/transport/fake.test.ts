import { describe, it, expect } from 'vitest'
import { FakeTransport } from '../../src/transport/fake'
import type { InboundMessage } from '../../src/transport/types'

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  id: 'M1', chatJid: '111@s.whatsapp.net', senderJid: '111@s.whatsapp.net',
  text: 'hello', ts: 1000, fromMe: false, ...over,
})

describe('FakeTransport', () => {
  it('delivers injected messages to the registered handler', async () => {
    const t = new FakeTransport()
    const seen: InboundMessage[] = []
    t.onMessage(async (m) => { seen.push(m) })
    await t.inject(msg({ text: 'hi' }))
    expect(seen).toHaveLength(1)
    expect(seen[0].text).toBe('hi')
  })

  it('captures outbound sends', async () => {
    const t = new FakeTransport()
    await t.send({ chatJid: '111@s.whatsapp.net', text: 'pong' })
    expect(t.sent).toEqual([{ chatJid: '111@s.whatsapp.net', text: 'pong' }])
  })
})
