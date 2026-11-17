import type { WAMessage } from 'baileys'
import type { InboundMessage } from './types'
import { isGroupJid } from '../access/jid'

// WhatsApp wraps some messages: a CAPTIONED document in documentWithCaptionMessage,
// disappearing media in viewOnce/ephemeral. The real content (with its caption) is
// nested inside — unwrap so mediaKind/toInbound see it instead of `undefined` (that's
// why a captioned .heic sent as a file silently vanished, caption and all).
export function unwrap(m: WAMessage): WAMessage {
  let msg: any = m.message
  for (let i = 0; i < 4 && msg; i++) {
    const inner =
      msg.documentWithCaptionMessage?.message ??
      msg.viewOnceMessage?.message ??
      msg.viewOnceMessageV2?.message ??
      msg.ephemeralMessage?.message
    if (!inner) break
    msg = inner
  }
  return msg === m.message ? m : ({ ...m, message: msg } as WAMessage)
}

export const isBroadcastJid = (jid: string) => jid === 'status@broadcast' || jid.endsWith('@newsletter')

// Metadata common to text + media messages (everything but the text body).
export function messageMeta(m: WAMessage): Omit<InboundMessage, 'text'> | null {
  const remoteJid = m.key.remoteJid
  if (!remoteJid || !m.key.id) return null
  // Statuses (stories) and channels aren't conversations: never ingest, describe or answer
  // them. Every path (live, media, history sync) goes through here.
  if (isBroadcastJid(remoteJid)) return null
  const isGroup = isGroupJid(remoteJid)
  // The actual sender. Baileys 7 sets participant to "" (not undefined) for 1:1 DMs;
  // in groups it's the member, sometimes only as participantAlt (phone form) on synced
  // history. In a GROUP we must NEVER fall back to remoteJid — that's the group itself
  // (and group ids start with the creator's number, so it masquerades as the creator).
  const participant = m.key.participant || (m.key as any).participantAlt || (m as any).participant || ''
  const senderJid = isGroup ? participant || 'unknown' : participant || remoteJid
  return {
    id: m.key.id,
    chatJid: remoteJid,
    senderJid,
    senderName: m.pushName ?? undefined,
    ts: Number(m.messageTimestamp ?? 0),
    fromMe: Boolean(m.key.fromMe),
    isGroup,
  }
}

// Does the message address the bot by name (either language, anywhere)? A softer wake
// than an @-mention — the model then judges whether it's talked TO vs. ABOUT.
export function nameAddressed(text: string): boolean {
  return /gizmo|גיזמו/i.test(text)
}

// contextInfo lives on whichever message-type object is present (text, audio,
// image, …) — a voice note's reply-context is on audioMessage, not text.
function getContextInfo(m: WAMessage): any {
  const msg: any = m.message
  if (!msg) return undefined
  return (
    msg.extendedTextMessage?.contextInfo ??
    msg.imageMessage?.contextInfo ??
    msg.videoMessage?.contextInfo ??
    msg.audioMessage?.contextInfo ??
    msg.documentMessage?.contextInfo ??
    undefined
  )
}

// If this message REPLIES to a photo, reconstruct the quoted image as a downloadable
// WAMessage (from contextInfo.quotedMessage + the quoted stanza id/author). Lets Gizmo
// act on "do X to this photo" without the user re-sending it. Handles both a normal
// photo and one sent "as a file" (image/* document, incl. HEIC). null if no quoted image.
export function quotedImage(m: WAMessage): WAMessage | null {
  const ctx = getContextInfo(m)
  const q: any = ctx?.quotedMessage
  if (!q) return null
  const isImage = q.imageMessage || (q.documentMessage?.mimetype ?? '').startsWith('image/')
  if (!isImage) return null
  return {
    key: { remoteJid: m.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
    message: q,
  } as WAMessage
}

// The TEXT of the message this one replies to (conversation / extended text / a media
// caption), so a reply to a text message surfaces its referent to the model. Without it a
// bare "this"/"זה" reaches the brain with nothing to resolve — and it may hallucinate what
// was "sent". Returns undefined when not a reply, when the quote is an image (quotedImage
// handles that), or when the quote carries no text.
export function quotedText(m: WAMessage): string | undefined {
  const q: any = getContextInfo(m)?.quotedMessage
  if (!q) return undefined
  if (q.imageMessage || (q.documentMessage?.mimetype ?? '').startsWith('image/')) return undefined
  const t =
    q.conversation ??
    q.extendedTextMessage?.text ??
    q.videoMessage?.caption ??
    q.documentMessage?.caption ??
    (q.audioMessage ? '[voice note]' : undefined)
  return typeof t === 'string' && t.trim() ? t.trim() : undefined
}

// Does this message @-mention the bot, or reply to a bot message? Works for any
// message type (text OR voice/image reply). Compares bare ids (phone or lid) so
// it matches regardless of @lid vs @s.whatsapp.net.
export function mentionsBot(m: WAMessage, botIds: string[]): boolean {
  if (botIds.length === 0) return false
  const ctx = getContextInfo(m)
  const ids = new Set(botIds.map((j) => j.split(/[:@]/)[0]))
  const mentioned = (ctx?.mentionedJid ?? []).some((j: string) => ids.has(j.split(/[:@]/)[0]))
  const repliedTo = ctx?.participant ? ids.has(ctx.participant.split(/[:@]/)[0]) : false
  return mentioned || repliedTo
}

// Decide whether a message wakes the bot, and mutate the inbound accordingly. 1:1 always
// wakes; a group wakes on an @-mention or reply-to-bot (direct) OR the bot's name in the
// text (soft — may be talked ABOUT, not TO, so the model judges). Shared by the text and
// media paths so both honor name-wake identically.
export function applyWake(inbound: InboundMessage, m: WAMessage, botIds: string[] = []): InboundMessage {
  if (!inbound.isGroup) {
    inbound.mentionsMe = true
    return inbound
  }
  const direct = mentionsBot(m, botIds)
  inbound.mentionsMe = direct || nameAddressed(inbound.text)
  inbound.softWake = inbound.mentionsMe && !direct
  return inbound
}

export function toInbound(m: WAMessage): InboundMessage | null {
  const msg = m.message
  // Text bodies + free media captions/filenames (no download). Voice notes and
  // caption-less images become searchable via STT/OCR (see media module).
  // A photo sent "as a file" (iPhone HEIC/original) is a documentMessage with an
  // image/* mimetype — treat its caption like an image caption.
  const isImageDoc = (msg?.documentMessage?.mimetype ?? '').startsWith('image/')
  const imageCaption = msg?.imageMessage?.caption ?? (isImageDoc ? msg?.documentMessage?.caption : undefined)
  const text =
    msg?.conversation ??
    msg?.extendedTextMessage?.text ??
    imageCaption ??
    msg?.videoMessage?.caption ??
    (!isImageDoc ? msg?.documentMessage?.caption : undefined) ??
    (!isImageDoc && msg?.documentMessage?.fileName ? `[document: ${msg.documentMessage.fileName}]` : null) ??
    null
  if (!text) return null
  const meta = messageMeta(m)
  if (!meta) return null
  return { ...meta, text }
}
