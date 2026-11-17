import { describe, it, expect } from 'vitest'
import { mediaKind, extractMediaText, buildMediaInbound, ingestOneMedia, type MediaDeps } from '../../src/media'
import type { WAMessage } from 'baileys'

const wm = (message: any): WAMessage => ({ key: { id: 'M', remoteJid: '1@s.whatsapp.net', fromMe: false }, message } as unknown as WAMessage)

const deps: MediaDeps = {
  transcribe: async () => 'shalom this is a voice note',
  ocr: async () => 'RECEIPT total 42',
  pdfText: async () => 'lease agreement text',
  docText: async (_b: Buffer, name: string) => (name.endsWith('.txt') ? 'plain notes' : ''),
}
const download = async () => Buffer.from('x')

describe('mediaKind', () => {
  it('classifies audio / image / pdf, ignores plain text', () => {
    expect(mediaKind(wm({ audioMessage: { ptt: true } }))).toBe('audio')
    expect(mediaKind(wm({ imageMessage: {} }))).toBe('image')
    expect(mediaKind(wm({ documentMessage: { mimetype: 'application/pdf' } }))).toBe('pdf')
    expect(mediaKind(wm({ documentMessage: { mimetype: 'application/zip', fileName: 'a.zip' } }))).toBe('doc')
    expect(mediaKind(wm({ documentMessage: { fileName: 'notes.txt' } }))).toBe('doc')
    expect(mediaKind(wm({ conversation: 'hi' }))).toBeNull()
  })
})

describe('extractMediaText', () => {
  it('routes voice → STT with a [voice] prefix', async () => {
    expect(await extractMediaText(wm({ audioMessage: {} }), download, deps)).toBe('[voice] shalom this is a voice note')
  })
  it('routes image → OCR with a [image] prefix', async () => {
    expect(await extractMediaText(wm({ imageMessage: {} }), download, deps)).toBe('[image] RECEIPT total 42')
  })
  it('prefers vision (describeImage) over OCR for images when available', async () => {
    const withVision = { ...deps, describeImage: async () => 'a golden retriever puppy on grass' }
    expect(await extractMediaText(wm({ imageMessage: {} }), download, withVision)).toBe('[image] a golden retriever puppy on grass')
  })
  it('falls back to OCR when vision throws (e.g. Gemini quota 429)', async () => {
    const visionDown = { ...deps, describeImage: async () => { throw new Error('gemini vision 429') } }
    expect(await extractMediaText(wm({ imageMessage: {} }), download, visionDown)).toBe('[image] RECEIPT total 42')
  })
  it('routes pdf → text extraction with a [pdf] prefix', async () => {
    expect(await extractMediaText(wm({ documentMessage: { mimetype: 'application/pdf' } }), download, deps)).toBe('[pdf] lease agreement text')
  })
  it('an unreadable document still reports that it ARRIVED (never silently dropped)', async () => {
    const out = await extractMediaText(wm({ documentMessage: { fileName: 'stay.msg', mimetype: 'application/vnd.ms-outlook' } }), download, deps)
    expect(out).toBe(`[doc] "stay.msg" received, but its text can't be read (unsupported file type, or a scan with no text)`)
  })
  it('returns null for non-media and for empty extraction', async () => {
    expect(await extractMediaText(wm({ conversation: 'hi' }), download, deps)).toBeNull()
    const emptyDeps = { ...deps, ocr: async () => '   ' }
    expect(await extractMediaText(wm({ imageMessage: {} }), download, emptyDeps)).toBeNull()
  })
})

describe('buildMediaInbound mentionsMe', () => {
  const botIds = ['888777@lid']
  const groupVoice = (ctx?: any): any => ({
    key: { id: 'M', remoteJid: '123@g.us', participant: '111@lid', fromMe: false },
    message: { audioMessage: ctx ? { contextInfo: ctx } : {} },
  })
  it('1:1 media is always addressed', () => {
    const dm: any = { key: { id: 'M', remoteJid: '111@s.whatsapp.net', fromMe: false }, message: { audioMessage: {} } }
    expect(buildMediaInbound(dm, '[voice] hi', botIds)?.mentionsMe).toBe(true)
  })
  it('group voice note replying to the bot IS addressed', () => {
    expect(buildMediaInbound(groupVoice({ participant: '888777@lid' }), '[voice] hi', botIds)?.mentionsMe).toBe(true)
  })
  it('fresh group voice note is NOT addressed', () => {
    expect(buildMediaInbound(groupVoice(), '[voice] hi', botIds)?.mentionsMe).toBe(false)
  })
})

describe('foldCaption — caption becomes the instruction the brain acts on', () => {
  it('leads with the caption, then the description', async () => {
    const { foldCaption } = await import('../../src/media')
    expect(foldCaption('make it professional', '[image] a headshot of a man')).toBe('make it professional\n[image] a headshot of a man')
  })
  it('caption alone when vision returned nothing (still actionable)', async () => {
    const { foldCaption } = await import('../../src/media')
    expect(foldCaption('add wings', null)).toBe('add wings')
  })
  it('description alone when there is no caption (bare photo)', async () => {
    const { foldCaption } = await import('../../src/media')
    expect(foldCaption(undefined, '[image] a dog')).toBe('[image] a dog')
  })
  it('null when neither (nothing to ingest or act on)', async () => {
    const { foldCaption } = await import('../../src/media')
    expect(foldCaption('  ', null)).toBeNull()
  })
})

describe('extractMediaText — documents', () => {
  it('routes a .txt document → docText with a [doc] prefix', async () => {
    const m: any = { key: { id: 'M', remoteJid: '1@s.whatsapp.net', fromMe: false }, message: { documentMessage: { fileName: 'notes.txt' } } }
    expect(await extractMediaText(m, download, deps)).toBe('[doc] plain notes')
  })
})

describe('ingestOneMedia — persists image bytes for later re-send', () => {
  it('calls persistImage(msgId, bytes) for an image; does NOT for a voice note', async () => {
    const saved: { id: string; len: number }[] = []
    const d: MediaDeps = { ...deps, describeImage: async () => 'a beach', persistImage: (id, buf) => saved.push({ id, len: buf.length }) }
    const dl = async () => Buffer.from('IMAGEBYTES')
    await ingestOneMedia(wm({ imageMessage: {} }), dl, d)
    expect(saved).toEqual([{ id: 'M', len: 10 }]) // keyed by msg id, real bytes
    await ingestOneMedia(wm({ audioMessage: {} }), dl, d) // voice → no persist
    expect(saved).toHaveLength(1)
  })
})

describe('captioned files + iPhone HEIC (documentWithCaptionMessage / image-as-file)', () => {
  it('mediaKind treats an image-mimetype document as an image (heic sent as a file)', () => {
    expect(mediaKind(wm({ documentMessage: { mimetype: 'image/heic', fileName: 'IMG.heic' } }))).toBe('image')
    expect(mediaKind(wm({ documentMessage: { mimetype: 'image/jpeg', fileName: 'IMG.jpg' } }))).toBe('image')
    expect(mediaKind(wm({ documentMessage: { mimetype: 'application/pdf' } }))).toBe('pdf')
    expect(mediaKind(wm({ documentMessage: { mimetype: 'text/plain', fileName: 'a.txt' } }))).toBe('doc')
  })
})

describe('unwrap — surfaces captioned documents (the vanished-caption bug)', () => {
  it('unwraps documentWithCaptionMessage so the caption + doc surface', async () => {
    const { unwrap, toInbound } = await import('../../src/transport/baileys-map')
    const wrapped: any = {
      key: { id: 'M', remoteJid: '111@s.whatsapp.net', fromMe: false },
      message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'image/heic', fileName: 'me.heic', caption: 'זה אני, דני' } } } },
    }
    const m = unwrap(wrapped)
    expect(m.message?.documentMessage?.caption).toBe('זה אני, דני')
    expect(mediaKind(m)).toBe('image') // and it flows through the media path
  })
  it('a plain message is returned unchanged', async () => {
    const { unwrap } = await import('../../src/transport/baileys-map')
    const plain: any = { key: { id: 'M' }, message: { conversation: 'hi' } }
    expect(unwrap(plain)).toBe(plain)
  })
})
