import type { WASocket } from 'baileys'
import type { MessageHandler, OutboundMessage, Transport } from './types'
import { unwrap, quotedImage, quotedText, messageMeta } from './baileys-map'
import { createTurnHandler } from './turn'
import { SocketBase, mediaDownloader } from './socket'
import { NO_MEDIA, type MediaDeps } from '../media'
import { isHeic, heicToJpeg } from '../media/providers'
import type { Config } from '../config'

export class BaileysTransport extends SocketBase implements Transport {
  private turnRespond: MessageHandler | null = null // per-turn reply (coalesced)
  private mediaDeps: MediaDeps | null = null
  private turnHandler: ((event: { type: string; messages: any[] }) => void) | null = null
  // Message-key tracking so react/quote (target the user's latest message) and
  // edit/delete (target Gizmo's own latest message) need no key threading through the brain.
  private lastInbound = new Map<string, any>() // latest incoming WAMessage per chat
  private lastOutbound = new Map<string, any>() // latest key Gizmo sent per chat
  private lastPoll = new Map<string, any>() // latest poll message Gizmo sent per chat (for tally)

  constructor(private readonly config: Config) {
    super()
  }

  // The reply handler — invoked ONCE per coalesced turn (a burst of messages collapses
  // into one call). Kept separate from onMessage (ingest) so history stays per-message.
  onTurn(handler: MessageHandler): void {
    this.turnRespond = handler
  }

  enableMedia(deps: MediaDeps): void {
    this.mediaDeps = deps
  }

  // The live socket, or throw if start() hasn't run.
  private get s(): WASocket {
    if (!this.sock) throw new Error('transport not started')
    return this.sock
  }

  private track(chatJid: string, sent: any): void {
    if (sent?.key) this.lastOutbound.set(chatJid, sent.key)
  }

  async send(msg: OutboundMessage): Promise<void> {
    this.track(msg.chatJid, await this.s.sendMessage(msg.chatJid, { text: msg.text }))
  }

  // A poll (WhatsApp shows the running tally to everyone natively). 2–12 options.
  async sendPoll(chatJid: string, question: string, options: string[]): Promise<void> {
    const values = options.map((o) => o.trim()).filter(Boolean).slice(0, 12)
    if (values.length < 2) throw new Error('a poll needs at least 2 options')
    const sent = await this.s.sendMessage(chatJid, { poll: { name: question, values, selectableCount: 1 } })
    this.track(chatJid, sent)
    if (sent) this.lastPoll.set(chatJid, sent)
  }

  // React to the user's latest message in this chat with an emoji (or '' to remove).
  async react(chatJid: string, emoji: string): Promise<void> {
    const target = this.lastInbound.get(chatJid)
    if (!target?.key) throw new Error('no message to react to')
    await this.s.sendMessage(chatJid, { react: { text: emoji, key: target.key } })
  }

  async sendLocation(chatJid: string, latitude: number, longitude: number, name?: string): Promise<void> {
    this.track(chatJid, await this.s.sendMessage(chatJid, { location: { degreesLatitude: latitude, degreesLongitude: longitude, name } }))
  }

  async sendContact(chatJid: string, name: string, phone: string): Promise<void> {
    const num = phone.replace(/[^\d+]/g, '')
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;waid=${num.replace(/\D/g, '')}:${num}\nEND:VCARD`
    this.track(chatJid, await this.s.sendMessage(chatJid, { contacts: { displayName: name, contacts: [{ vcard }] } }))
  }

  // Send a photo that vanishes after one view.
  async sendViewOnce(chatJid: string, image: Buffer, caption?: string): Promise<void> {
    this.track(chatJid, await this.s.sendMessage(chatJid, { image, caption, viewOnce: true }))
  }

  // Reply quoting the user's latest message in this chat.
  async replyQuote(chatJid: string, text: string): Promise<void> {
    const quoted = this.lastInbound.get(chatJid)
    this.track(chatJid, await this.s.sendMessage(chatJid, { text }, quoted ? { quoted } : {}))
  }

  // Edit / delete Gizmo's OWN latest message in this chat.
  async editLast(chatJid: string, text: string): Promise<void> {
    const key = this.lastOutbound.get(chatJid)
    if (!key) throw new Error('no message of mine to edit')
    await this.s.sendMessage(chatJid, { text, edit: key })
  }
  async deleteLast(chatJid: string): Promise<void> {
    const key = this.lastOutbound.get(chatJid)
    if (!key) throw new Error('no message of mine to delete')
    await this.s.sendMessage(chatJid, { delete: key })
  }

  // WhatsApp presence: 'composing' = "typing…", 'recording' = "recording audio…",
  // 'paused' clears it. Best-effort — never let a presence hiccup break a reply.
  async sendPresence(chatJid: string, type: 'composing' | 'recording' | 'paused'): Promise<void> {
    try {
      await this.sock?.sendPresenceUpdate(type, chatJid)
    } catch {
      /* presence is cosmetic; ignore */
    }
  }

  // Send a voice note. `audio` = Opus/OGG; `seconds` = duration (WhatsApp Web
  // needs it to play).
  async sendVoice(chatJid: string, audio: Buffer, seconds?: number): Promise<void> {
    await this.s.sendMessage(chatJid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds })
  }

  async sendImage(chatJid: string, image: Buffer, caption?: string): Promise<void> {
    this.track(chatJid, await this.s.sendMessage(chatJid, { image, caption }))
  }

  async sendDocument(chatJid: string, document: Buffer, fileName: string, mimetype: string, caption?: string): Promise<void> {
    this.track(chatJid, await this.s.sendMessage(chatJid, { document, fileName, mimetype, caption }))
  }

  async sendVideo(chatJid: string, video: Buffer, caption?: string): Promise<void> {
    this.track(chatJid, await this.s.sendMessage(chatJid, { video, caption }))
  }

  // WhatsApp "GIF" = an MP4 played on loop.
  async sendGif(chatJid: string, mp4: Buffer): Promise<void> {
    await this.s.sendMessage(chatJid, { video: mp4, gifPlayback: true })
  }

  // Set the bot's own WhatsApp profile picture (WhatsApp crops to a square).
  async setAvatar(image: Buffer): Promise<void> {
    if (!this.sock?.user) throw new Error('transport not started')
    await this.sock.updateProfilePicture(this.sock.user.id, image)
  }

  async start(): Promise<void> {
    const sock = await this.connect({
      credsDir: this.config.credsDir,
      number: this.config.dedicatedNumber,
      label: 'dedicated',
      phone: 'the dedicated phone',
    })

    sock.ev.on('messaging-history.set', ({ contacts }: any) => this.reportContacts(contacts))

    sock.ev.on('messages.upsert', async (event) => {
      if (!this.handler) return
      const botIds = [sock.user?.id, (sock.user as any)?.lid].filter(Boolean) as string[]
      // If a message REPLIES to a photo, download that quoted photo and stash it FIRST,
      // so the brain (running on the reply text) can act on it — "do X to this photo"
      // without re-sending. WhatsApp doesn't surface the reply context to the model, so
      // we resolve it here.
      // Remember each incoming message so react/quote can target "the message you just sent".
      if (event.type === 'notify') {
        for (const raw of event.messages) {
          const m = unwrap(raw)
          const meta = messageMeta(m)
          if (meta && !m.key.fromMe) this.lastInbound.set(meta.chatJid, m)
        }
      }
      // Resolve reply context: WhatsApp doesn't surface the quoted message to the model, so
      // do it here. A reply to a PHOTO → stash + describe it (act on "do X to this photo").
      // A reply to TEXT → surface the quoted text as the referent, so a bare "this"/"זה"
      // has something to resolve instead of the model hallucinating what was "sent".
      if (event.type === 'notify') {
        for (const raw of event.messages) {
          const m = unwrap(raw)
          const meta = messageMeta(m)
          if (!meta) continue
          const q = this.mediaDeps?.onImage && (this.mediaDeps.shouldProcess?.(meta) ?? true) ? quotedImage(m) : null
          if (q) {
            try {
              let buf = await mediaDownloader(() => this.sock)(q)
              const mime = q.message?.imageMessage?.mimetype ?? q.message?.documentMessage?.mimetype ?? 'image/jpeg'
              if (isHeic(mime, q.message?.documentMessage?.fileName ?? '')) buf = await heicToJpeg(buf)
              this.mediaDeps!.onImage!(meta.chatJid, buf, 'image/jpeg')
              const desc = this.mediaDeps!.describeImage ? await this.mediaDeps!.describeImage(buf, 'image/jpeg').catch(() => '') : ''
              const et: any = m.message?.extendedTextMessage
              if (et) et.text = `${et.text ?? ''}\n[image] ${desc || 'the photo you replied to'}`
            } catch (err) {
              console.error('quoted-image fetch failed:', (err as Error).message)
            }
            continue
          }
          // Reply to text/other: prepend the quoted text so the model sees what "this" means.
          const qt = quotedText(m)
          if (qt) {
            const et: any = m.message?.extendedTextMessage
            const ref = qt.length > 300 ? `${qt.slice(0, 300)}…` : qt
            if (et) et.text = `[replying to: "${ref}"]\n${et.text ?? ''}`
          }
        }
      }
      // Single path: per-message ingest + a coalesced, per-turn reply. Built once (needs
      // sock for downloads + botIds). A burst of messages → one respond() call.
      this.turnHandler ??= createTurnHandler({
        download: mediaDownloader(() => this.sock),
        ingest: this.handler,
        respond: this.turnRespond ?? undefined,
        deps: this.mediaDeps ?? NO_MEDIA,
        botIds,
        debounceMs: this.config.turnDebounceMs,
      })
      this.turnHandler(event)
    })
  }
}
