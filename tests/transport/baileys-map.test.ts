import { describe, it, expect } from 'vitest'
import { toInbound, mentionsBot, nameAddressed, applyWake, messageMeta } from '../../src/transport/baileys-map'
import type { WAMessage } from 'baileys'
import type { InboundMessage } from '../../src/transport/types'

const base = (over: any = {}): WAMessage => ({
  key: { id: 'M1', remoteJid: '111@s.whatsapp.net', fromMe: false, ...(over.key ?? {}) },
  messageTimestamp: 1700000000,
  pushName: 'Dana',
  message: over.message ?? { conversation: 'hello' },
}) as unknown as WAMessage

describe('toInbound', () => {
  it('maps a plain text (conversation) message', () => {
    const r = toInbound(base())
    expect(r).toEqual({
      id: 'M1', chatJid: '111@s.whatsapp.net', senderJid: '111@s.whatsapp.net',
      senderName: 'Dana', text: 'hello', ts: 1700000000, fromMe: false, isGroup: false,
    })
  })

  it('maps an extendedTextMessage', () => {
    const r = toInbound(base({ message: { extendedTextMessage: { text: 'yo' } } }))
    expect(r?.text).toBe('yo')
  })

  it('uses participant as senderJid in groups', () => {
    const r = toInbound(base({
      key: { id: 'M2', remoteJid: 'g@g.us', participant: '999@s.whatsapp.net', fromMe: false },
    }))
    expect(r?.chatJid).toBe('g@g.us')
    expect(r?.senderJid).toBe('999@s.whatsapp.net')
  })

  it('in a group, NEVER attributes to the group jid when participant is empty', () => {
    // The bug: empty participant fell back to remoteJid (the group), so every such
    // message looked like it came from the group creator. Must not happen.
    const r = toInbound(base({
      key: { id: 'M2b', remoteJid: '972-123@g.us', participant: '', fromMe: false },
    }))
    expect(r?.senderJid).not.toBe('972-123@g.us') // not the group
    expect(r?.senderJid).toBe('unknown')
  })

  it('in a group, uses participantAlt (phone form) when participant is empty', () => {
    const r = toInbound(base({
      key: { id: 'M2c', remoteJid: 'g@g.us', participant: '', participantAlt: '972555@s.whatsapp.net', fromMe: false },
    }))
    expect(r?.senderJid).toBe('972555@s.whatsapp.net')
  })

  it('returns null for media with no caption (no text yet — STT/OCR later)', () => {
    expect(toInbound(base({ message: { imageMessage: {} } }))).toBeNull()
    expect(toInbound(base({ message: { audioMessage: { ptt: true } } }))).toBeNull()
  })

  it('captures an image caption as searchable text', () => {
    const r = toInbound(base({ message: { imageMessage: { caption: 'the new couch' } } }))
    expect(r?.text).toBe('the new couch')
  })

  it('captures a document filename', () => {
    const r = toInbound(base({ message: { documentMessage: { fileName: 'lease.pdf' } } }))
    expect(r?.text).toBe('[document: lease.pdf]')
  })

  it('flags group chats via isGroup', () => {
    expect(toInbound(base({ key: { id: 'g', remoteJid: '123@g.us', fromMe: false }, message: { conversation: 'hi' } }))?.isGroup).toBe(true)
    expect(toInbound(base())?.isGroup).toBe(false)
  })
})

describe('mentionsBot', () => {
  const botIds = ['972500000300:5@s.whatsapp.net', '888777@lid']
  const withCtx = (ctx: any): any => ({ message: { extendedTextMessage: { text: 'hey', contextInfo: ctx } } })
  it('detects an @-mention of the bot (by lid or phone, any device suffix)', () => {
    expect(mentionsBot(withCtx({ mentionedJid: ['888777@lid'] }), botIds)).toBe(true)
    expect(mentionsBot(withCtx({ mentionedJid: ['972500000300@s.whatsapp.net'] }), botIds)).toBe(true)
  })
  it('detects a reply to the bot', () => {
    expect(mentionsBot(withCtx({ participant: '888777:3@lid' }), botIds)).toBe(true)
  })
  it('is false when someone else is mentioned / no botIds', () => {
    expect(mentionsBot(withCtx({ mentionedJid: ['999@lid'] }), botIds)).toBe(false)
    expect(mentionsBot(withCtx({ mentionedJid: ['888777@lid'] }), [])).toBe(false)
  })
  it('detects a VOICE NOTE reply to the bot (contextInfo on audioMessage)', () => {
    const voiceReply: any = { message: { audioMessage: { ptt: true, contextInfo: { participant: '888777@lid' } } } }
    expect(mentionsBot(voiceReply, botIds)).toBe(true)
    const freshVoice: any = { message: { audioMessage: { ptt: true } } }
    expect(mentionsBot(freshVoice, botIds)).toBe(false) // fresh voice note = not addressed
  })

  it('falls back to remoteJid when participant is an empty string (Baileys 7 DMs)', () => {
    const r = toInbound(base({
      key: { id: 'M3', remoteJid: '111@s.whatsapp.net', participant: '', fromMe: false },
    }))
    expect(r?.senderJid).toBe('111@s.whatsapp.net')
  })
})

describe('nameAddressed', () => {
  it('matches the bot name anywhere, either language, case-insensitive', () => {
    expect(nameAddressed('gizmo what time is it')).toBe(true)
    expect(nameAddressed('היי גיזמו מה קורה')).toBe(true)
    expect(nameAddressed('hey GIZMO')).toBe(true)
  })
  it('is false when the name is absent', () => {
    expect(nameAddressed('what time is it')).toBe(false)
    expect(nameAddressed('מה השעה')).toBe(false)
    expect(nameAddressed('')).toBe(false)
  })
})

describe('applyWake — wake on name (group) vs @-mention/reply', () => {
  const grpMsg = (text: string): WAMessage => ({
    key: { id: 'G1', remoteJid: 'fam@g.us', participant: '999@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1700000000, pushName: 'X', message: { conversation: text },
  }) as unknown as WAMessage
  const seenOf = async (m: WAMessage): Promise<InboundMessage | undefined> => applyWake(toInbound(m)!, m, []) // no botIds → no @-tag match
  const wake = async (m: WAMessage) => (await seenOf(m))?.mentionsMe

  it('group message with the name (no @-tag) wakes Gizmo — as a SOFT wake', async () => {
    const s = await seenOf(grpMsg('גיזמו מה מילת הקוד?'))
    expect(s?.mentionsMe).toBe(true)
    expect(s?.softWake).toBe(true) // name only → might be talked about, not to
  })
  it('group message with neither name nor tag stays asleep', async () => {
    expect(await wake(grpMsg('סתם צאט בין אנשים'))).toBe(false)
  })
  it('DM behavior unchanged — always addressed', async () => {
    const dm = { key: { id: 'D1', remoteJid: '111@s.whatsapp.net', fromMe: false }, messageTimestamp: 1, pushName: 'X', message: { conversation: 'no name here' } } as unknown as WAMessage
    expect(applyWake(toInbound(dm)!, dm, []).mentionsMe).toBe(true)
  })
})

describe('quotedImage — replying to a photo', () => {
  it('reconstructs a downloadable image WAMessage from the reply context', async () => {
    const { quotedImage } = await import('../../src/transport/baileys-map')
    const reply: any = {
      key: { remoteJid: '111@s.whatsapp.net', id: 'REPLY1', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'add my mom to this',
          contextInfo: { stanzaId: 'ORIG9', participant: '111@s.whatsapp.net', quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } } },
        },
      },
    }
    const q = quotedImage(reply)!
    expect(q.key.id).toBe('ORIG9') // the quoted message id (for media download)
    expect(q.message?.imageMessage).toBeTruthy()
  })
  it('handles a quoted photo sent as a file (image/heic document)', async () => {
    const { quotedImage } = await import('../../src/transport/baileys-map')
    const reply: any = {
      key: { remoteJid: '111@s.whatsapp.net', id: 'R', fromMe: false },
      message: { extendedTextMessage: { text: 'edit this', contextInfo: { stanzaId: 'O', quotedMessage: { documentMessage: { mimetype: 'image/heic' } } } } },
    }
    expect(quotedImage(reply)?.message?.documentMessage?.mimetype).toBe('image/heic')
  })
  it('returns null when the reply quotes text (not a photo) or is not a reply', async () => {
    const { quotedImage } = await import('../../src/transport/baileys-map')
    const textReply: any = { key: {}, message: { extendedTextMessage: { text: 'ok', contextInfo: { quotedMessage: { conversation: 'hi' } } } } }
    const noReply: any = { key: {}, message: { conversation: 'hello' } }
    expect(quotedImage(textReply)).toBeNull()
    expect(quotedImage(noReply)).toBeNull()
  })
})

describe('quotedText — replying to a text message', () => {
  it('surfaces the quoted text (conversation)', async () => {
    const { quotedText } = await import('../../src/transport/baileys-map')
    const reply: any = { key: {}, message: { extendedTextMessage: { text: 'זה', contextInfo: { quotedMessage: { conversation: 'buy mom 100 baht' } } } } }
    expect(quotedText(reply)).toBe('buy mom 100 baht')
  })
  it('surfaces extendedText, video/doc captions, and a voice-note placeholder', async () => {
    const { quotedText } = await import('../../src/transport/baileys-map')
    const ext: any = { key: {}, message: { extendedTextMessage: { text: 'x', contextInfo: { quotedMessage: { extendedTextMessage: { text: 'earlier reply' } } } } } }
    const vid: any = { key: {}, message: { extendedTextMessage: { text: 'x', contextInfo: { quotedMessage: { videoMessage: { caption: 'clip cap' } } } } } }
    const voice: any = { key: {}, message: { extendedTextMessage: { text: 'x', contextInfo: { quotedMessage: { audioMessage: {} } } } } }
    expect(quotedText(ext)).toBe('earlier reply')
    expect(quotedText(vid)).toBe('clip cap')
    expect(quotedText(voice)).toBe('[voice note]')
  })
  it('returns undefined for an image quote (quotedImage owns it) and for no reply', async () => {
    const { quotedText } = await import('../../src/transport/baileys-map')
    const img: any = { key: {}, message: { extendedTextMessage: { text: 'edit this', contextInfo: { quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } } } } } }
    const noReply: any = { key: {}, message: { conversation: 'hello' } }
    expect(quotedText(img)).toBeUndefined()
    expect(quotedText(noReply)).toBeUndefined()
  })
})

describe('statuses and channels are never ingested', () => {
  const msg = (remoteJid: string) => ({ key: { remoteJid, id: 'S1', fromMe: false, participant: '972500000000@s.whatsapp.net' }, message: { conversation: 'my story' }, messageTimestamp: 1 }) as unknown as WAMessage
  it('drops status@broadcast and @newsletter at messageMeta (live, media and history sync all use it)', () => {
    expect(messageMeta(msg('status@broadcast'))).toBeNull()
    expect(toInbound(msg('status@broadcast'))).toBeNull()
    expect(toInbound(msg('120363000000000000@newsletter'))).toBeNull()
    expect(toInbound(msg('972500000000@s.whatsapp.net'))?.text).toBe('my story')
  })
})
