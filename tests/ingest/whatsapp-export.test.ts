import { describe, it, expect } from 'vitest'
import { parseExport } from '../../src/ingest/whatsapp-export'

const IOS = `[12/03/2022, 14:23:01] Dana: hello there
[12/03/2022, 14:24:10] Gil: hi Dana
how are you?
[12/03/2022, 14:25:00] Dana: good!`

describe('parseExport (iOS bracket format)', () => {
  it('parses messages and joins continuation lines', () => {
    const msgs = parseExport(IOS, 'chatX')
    expect(msgs).toHaveLength(3)
    expect(msgs[0].senderName).toBe('Dana')
    expect(msgs[0].text).toBe('hello there')
    expect(msgs[1].senderName).toBe('Gil')
    expect(msgs[1].text).toBe('hi Dana\nhow are you?')
    expect(msgs[0].source).toBe('export')
    expect(msgs[0].chatJid).toBe('chatX')
  })

  it('produces stable ids (idempotent re-import)', () => {
    const a = parseExport(IOS, 'chatX')
    const b = parseExport(IOS, 'chatX')
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id))
  })

  it('skips system lines (no Sender: colon)', () => {
    const withSystem = `[12/03/2022, 14:00:00] Messages to this chat are now secured\n${IOS}`
    const msgs = parseExport(withSystem, 'chatX')
    expect(msgs).toHaveLength(3)
  })
})

describe('parseExport (Android dash format)', () => {
  it('parses dash format', () => {
    const AND = `12/03/2022, 14:23 - Dana: hey\n12/03/2022, 14:24 - Gil: yo`
    const msgs = parseExport(AND, 'chatY')
    expect(msgs.map((m) => m.senderName)).toEqual(['Dana', 'Gil'])
    expect(msgs[0].text).toBe('hey')
  })
})
