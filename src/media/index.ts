import type { WAMessage } from 'baileys'
import type { InboundMessage } from '../transport/types'
import { messageMeta, mentionsBot, nameAddressed } from '../transport/baileys-map'
import { isHeic, heicToJpeg } from './providers'

export type MediaKind = 'audio' | 'image' | 'pdf' | 'doc'

export function mediaKind(m: WAMessage): MediaKind | null {
  const msg = m.message
  if (msg?.audioMessage) return 'audio'
  if (msg?.imageMessage) return 'image'
  // A photo sent "as a file" (iPhone HEIC/original) is a documentMessage with an
  // image/* mimetype — treat it as an image so it flows through the photo path.
  if ((msg?.documentMessage?.mimetype ?? '').startsWith('image/')) return 'image'
  if (msg?.documentMessage?.mimetype?.includes('pdf')) return 'pdf'
  if (msg?.documentMessage) return 'doc' // txt/docx/xlsx/zip/… — docText sorts by extension, drops unsupported
  return null
}

// Caption / mimetype / filename read across an imageMessage OR a document-image.
function imageCaptionOf(m: WAMessage): string | undefined {
  return m.message?.imageMessage?.caption ?? m.message?.documentMessage?.caption ?? undefined
}
function imageMimeOf(m: WAMessage): string {
  return m.message?.imageMessage?.mimetype ?? m.message?.documentMessage?.mimetype ?? 'image/jpeg'
}
function imageFileOf(m: WAMessage): string {
  return m.message?.documentMessage?.fileName ?? ''
}

export interface MediaDeps {
  transcribe(buf: Buffer, mimetype: string): Promise<string>
  ocr(buf: Buffer): Promise<string>
  pdfText(buf: Buffer): Promise<string>
  docText(buf: Buffer, filename: string, mimetype: string): Promise<string> // txt/docx/xlsx/zip → text; '' if unsupported
  describeImage?(buf: Buffer, mimetype: string): Promise<string> // vision: supersedes OCR for images when present
  onImage?(chatJid: string, buf: Buffer, mimetype: string): void // stash sent images (e.g. for set_avatar)
  persistImage?(msgId: string, buf: Buffer): void // save image bytes to disk (keyed by msg id) so they can be re-sent later
  // Download + paid vision/STT only when this returns true (absent = always). A skipped media
  // message still keeps its free caption/filename. Keeps strangers from spending on Gizmo.
  shouldProcess?(meta: Omit<InboundMessage, 'text'>): boolean
}

// Media not enabled → extraction yields nothing; a captioned media message still keeps its caption.
export const NO_MEDIA: MediaDeps = {
  transcribe: async () => '',
  ocr: async () => '',
  pdfText: async () => '',
  docText: async () => '',
}

const PREFIX: Record<MediaKind, string> = { audio: '[voice] ', image: '[image] ', pdf: '[pdf] ', doc: '[doc] ' }
const DOC_CAP = 24_000 // ~6-8k tokens; keep one big doc from blowing the context window

// Download + extract searchable text from a media message. Returns null if not
// processable or the extraction yields nothing.
export async function extractMediaText(
  m: WAMessage,
  download: () => Promise<Buffer>,
  deps: MediaDeps,
): Promise<string | null> {
  const kind = mediaKind(m)
  if (!kind) return null
  const buf = await download()
  let text = ''
  if (kind === 'audio') text = await deps.transcribe(buf, m.message?.audioMessage?.mimetype ?? 'audio/ogg')
  else if (kind === 'image') {
    // Buffers reach here already decoded to JPEG (ingestOneMedia converts HEIC),
    // so label heic sources as jpeg to match the bytes vision receives.
    const rawMime = imageMimeOf(m)
    const mime = isHeic(rawMime, imageFileOf(m)) ? 'image/jpeg' : rawMime
    // Prefer vision (understands + reads text); fall back to OCR if vision is
    // absent OR fails (e.g. Gemini quota 429) so images never silently vanish.
    if (deps.describeImage) {
      try {
        text = await deps.describeImage(buf, mime)
      } catch (err) {
        console.error('vision failed, falling back to OCR:', (err as Error).message)
        text = await deps.ocr(buf)
      }
    } else {
      text = await deps.ocr(buf)
    }
  } else if (kind === 'pdf') text = await deps.pdfText(buf)
  else if (kind === 'doc') {
    const doc = m.message?.documentMessage
    text = await deps.docText(buf, doc?.fileName ?? '', doc?.mimetype ?? '')
  }
  text = text.trim()
  if ((kind === 'doc' || kind === 'pdf') && text.length > DOC_CAP) text = text.slice(0, DOC_CAP) + '\n…[truncated]'
  // A file that yields no text still ARRIVED — say so, or the brain sees only the caption
  // and tells the sender "nothing came through".
  if (!text && (kind === 'doc' || kind === 'pdf')) {
    const name = m.message?.documentMessage?.fileName ?? 'file'
    return `${PREFIX[kind]}"${name}" received, but its text can't be read (unsupported file type, or a scan with no text)`
  }
  return text ? PREFIX[kind] + text : null
}

// A caption is the user's INSTRUCTION ("make it professional"); the description is
// context. The brain needs the instruction to act — lead with it, and act on the
// caption alone even if vision returned nothing.
export function foldCaption(caption: string | null | undefined, desc: string | null): string | null {
  const c = caption?.trim()
  return c ? (desc ? `${c}\n${desc}` : c) : desc
}

export function buildMediaInbound(m: WAMessage, text: string, botIds: string[] = []): InboundMessage | null {
  const meta = messageMeta(m)
  if (!meta) return null
  // Addressing: 1:1 always; group on @-mention, reply-to-bot, OR the bot's name in the
  // caption (a captioned photo is the only pass that runs the brain for that photo, so
  // it must honor name-wake the text pass would otherwise have handled).
  const mentionsMe = meta.isGroup ? mentionsBot(m, botIds) || nameAddressed(text) : true
  return { ...meta, text, mentionsMe }
}

// Process ONE media message end-to-end: download, decode HEIC, stash images (onImage),
// extract text (vision/transcribe/OCR/pdf/doc), fold in a caption, and build the inbound.
// Batching N photos into one reply is the turn coalescer's job. Returns null
// if nothing is extractable (a bare, undescribable photo still returns its "[image]" line).
export async function ingestOneMedia(
  m: WAMessage,
  download: (m: WAMessage) => Promise<Buffer>,
  deps: MediaDeps,
  botIds: string[] = [],
): Promise<InboundMessage | null> {
  const meta = messageMeta(m)
  if (!meta) return null
  const isImage = mediaKind(m) === 'image'
  let buf = await download(m)
  if (isImage && isHeic(imageMimeOf(m), imageFileOf(m))) buf = await heicToJpeg(buf)
  if (isImage && deps.onImage) deps.onImage(meta.chatJid, buf, 'image/jpeg')
  if (isImage && meta.id) deps.persistImage?.(meta.id, buf) // keep the bytes so it can be re-sent later
  const desc = await extractMediaText(m, async () => buf, deps)
  const text = foldCaption(imageCaptionOf(m), desc)
  if (!text) return null
  return buildMediaInbound(m, text, botIds)
}
