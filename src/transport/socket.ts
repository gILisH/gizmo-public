import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type WAMessage,
  type WASocket,
} from 'baileys'
import pino from 'pino'
import type { MessageHandler } from './types'
import { syncAllGroups, wireGroupEvents, type GroupSyncHandlers } from './group-sync'

const logger = pino({ level: process.env.GIZMO_LOG_LEVEL ?? 'warn' })

// Download a message's media. Re-uploads go through the CURRENT socket (getSock is read at
// call time) — a closure over one socket would hit a dead one after a reconnect.
export const mediaDownloader = (getSock: () => WASocket | null) => (m: WAMessage): Promise<Buffer> =>
  downloadMediaMessage(m, 'buffer', {}, {
    logger: undefined as any,
    reuploadRequest: (msg) => {
      const sock = getSock()
      if (!sock) throw new Error('transport not started')
      return sock.updateMediaMessage(msg)
    },
  }) as Promise<Buffer>

// What both WhatsApp sockets share: the listener setters, contact/group reporting, and the
// connect → pair → reconnect-with-backoff lifecycle. Deliberately NO send path here — the
// personal socket's read-only guarantee is that nothing it inherits can send.
export abstract class SocketBase {
  protected sock: WASocket | null = null
  protected handler: MessageHandler | null = null // per-message ingest
  private onNames: ((names: { jid: string; name: string }[]) => void) | null = null
  private onMembersCb: ((chatJid: string, members: string[], mode: 'set' | 'add' | 'remove') => void) | null = null
  private onContactsCb: ((contacts: { jid: string; name: string }[]) => void) | null = null
  private reconnectAttempts = 0 // exponential backoff — reset on a clean 'open'
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  abstract start(): Promise<void>

  onMessage(handler: MessageHandler): void {
    this.handler = handler
  }

  // Report group names (subjects) so search results can say WHICH group.
  onGroupNames(cb: (names: { jid: string; name: string }[]) => void): void {
    this.onNames = cb
  }

  // Report group membership (participant JIDs) for the per-chat access ACL.
  onMembers(cb: (chatJid: string, members: string[], mode: 'set' | 'add' | 'remove') => void): void {
    this.onMembersCb = cb
  }

  // Report contact names (address book + push-names) so historical senders resolve.
  onContacts(cb: (contacts: { jid: string; name: string }[]) => void): void {
    this.onContactsCb = cb
  }

  protected reportContacts(contacts: any[]): void {
    if (!this.onContactsCb || !contacts?.length) return
    const named = contacts
      .map((c) => ({ jid: c.id as string, name: (c.name || c.verifiedName || c.notify) as string }))
      .filter((c) => c.jid && c.name)
    if (named.length) this.onContactsCb(named)
  }

  private groupHandlers(): GroupSyncHandlers {
    return { onNames: this.onNames ?? undefined, onMembers: this.onMembersCb ?? undefined }
  }

  // Open the socket: auth, live WA-Web version, pairing code on first run, group sync on
  // open, and reconnect with exponential backoff on any close but a logout.
  protected async connect(o: {
    credsDir: string
    number: string // for the pairing code
    label: string // 'dedicated' | 'personal' — logs read "<label> socket connected"
    phone: string // pairing instructions: which phone to link from
    socketOpts?: { markOnlineOnConnect?: boolean }
    onLoggedOut?: () => void
  }): Promise<WASocket> {
    const { state, saveCreds } = await useMultiFileAuthState(o.credsDir)
    // Track the live WhatsApp-Web version — a stale bundled version gets rejected (405).
    const { version } = await fetchLatestBaileysVersion()
    const sock = noLinkPreviews(makeWASocket({ auth: state, logger, version, ...o.socketOpts }))
    this.sock = sock
    sock.ev.on('creds.update', saveCreds)

    if (!sock.authState.creds.registered) {
      await new Promise((r) => setTimeout(r, 3000)) // let the socket get ready to issue the request
      const code = await sock.requestPairingCode(o.number)
      console.log(`\n=== ${o.label.toUpperCase()} PAIRING CODE: ${code} ===`)
      console.log(`On ${o.phone}: WhatsApp > Linked Devices > Link with phone number > enter this code.\n`)
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`${o.label} connection closed (status ${statusCode}); logged out — re-pair needed`)
          o.onLoggedOut?.()
          return
        }
        // Exponential backoff: reconnecting instantly on a 503/428 hammers WhatsApp and
        // triggers MORE throttling — a self-sustaining storm. Back off 2s→4s→…→60s.
        const delay = Math.min(60_000, 2000 * 2 ** this.reconnectAttempts)
        this.reconnectAttempts++
        console.log(`${o.label} connection closed (status ${statusCode}); reconnecting in ${Math.round(delay / 1000)}s`)
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = setTimeout(() => void this.start(), delay)
      } else if (connection === 'open') {
        this.reconnectAttempts = 0
        console.log(`${o.label} socket connected`)
        void syncAllGroups(sock, this.groupHandlers(), o.label)
      }
    })

    sock.ev.on('contacts.upsert', (contacts: any) => this.reportContacts(contacts))
    wireGroupEvents(sock, this.groupHandlers())
    return sock
  }
}

// Baileys fetches a link preview (link-preview-js + og:image) for every URL in outgoing
// text, from inside this container — a guest who gets Gizmo to repeat a URL gets a blind
// GET to compose-network services. There's no socket option for it, but sendMessage
// spreads per-call options over its own getUrlInfo, so force it off on every send.
export function noLinkPreviews<S extends Pick<WASocket, 'sendMessage'>>(sock: S): S {
  const send = sock.sendMessage.bind(sock)
  sock.sendMessage = ((jid, content, options = {}) => send(jid, content, { ...options, getUrlInfo: undefined } as typeof options)) as S['sendMessage']
  return sock
}
