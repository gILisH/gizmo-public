import { describe, it, expect } from 'vitest'
import { openStore } from '../../src/store'
import { makeIngestHandler, chain } from '../../src/ingest/handler'
import type { InboundMessage } from '../../src/transport/types'

const inbound = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  id: 'M1', chatJid: 'c@s.whatsapp.net', senderJid: 's@s.whatsapp.net',
  senderName: 'Dana', text: 'hi', ts: 1700000000, fromMe: false, ...over,
})

describe('ingest handler', () => {
  it('persists inbound messages with a source-namespaced id and contact name', async () => {
    const s = openStore(':memory:')
    const h = makeIngestHandler(s, 'dedicated')
    await h(inbound())
    expect(s.getMessage('dedicated:M1')?.source).toBe('dedicated')
    expect(s.getContactName('s@s.whatsapp.net')).toBe('Dana')
    s.close()
  })

  it('two sockets seeing the same WhatsApp id do not clobber each other', async () => {
    const s = openStore(':memory:')
    // Same msg id M1, opposite fromMe — the owner↔Gizmo DM seen by both sockets.
    await makeIngestHandler(s, 'dedicated')(inbound({ id: 'M1', fromMe: false }))
    await makeIngestHandler(s, 'personal')(inbound({ id: 'M1', fromMe: true }))
    expect(s.getMessage('dedicated:M1')?.fromMe).toBe(false) // dedicated keeps the user turn
    expect(s.getMessage('personal:M1')?.fromMe).toBe(true) // personal's view coexists
    s.close()
  })

  it('attributes fromMe messages to the feed owner, not the 1:1 chat partner', async () => {
    const s = openStore(':memory:')
    const ownerJid = '972500000100@s.whatsapp.net'
    const h = makeIngestHandler(s, 'personal', undefined, ownerJid)
    // Owner sent this in a DM with Asia — Baileys gives no participant, so senderJid=Asia (wrong).
    await h(inbound({ id: 'M9', chatJid: 'asia@s.whatsapp.net', senderJid: 'asia@s.whatsapp.net', senderName: undefined, fromMe: true }))
    const m = s.getMessage('personal:M9')
    expect(m?.senderJid).toBe(ownerJid) // re-attributed to the owner
    // a RECEIVED message keeps the real sender
    await h(inbound({ id: 'M10', chatJid: 'asia@s.whatsapp.net', senderJid: 'asia@s.whatsapp.net', fromMe: false }))
    expect(s.getMessage('personal:M10')?.senderJid).toBe('asia@s.whatsapp.net')
    s.close()
  })

  it('chain runs handlers in order', async () => {
    const calls: string[] = []
    const a = async () => { calls.push('a') }
    const b = async () => { calls.push('b') }
    await chain(a, b)(inbound())
    expect(calls).toEqual(['a', 'b'])
  })
})
