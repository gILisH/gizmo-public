import { toInbound } from './baileys-map'
import { createTurnHandler } from './turn'
import { SocketBase, mediaDownloader } from './socket'
import { NO_MEDIA, type MediaDeps } from '../media'

export interface ReadOnlyConfig {
  personalNumber: string
  credsDir: string
}

/**
 * Read-only companion socket for the PERSONAL number. It exposes only
 * receive/read — there is NO `send` method on this class (or on SocketBase). The absence
 * of a send path (not a runtime guard) is the structural guarantee that Gizmo can
 * never message from the owner's main number by accident.
 */
export class ReadOnlyBaileysTransport extends SocketBase {
  private mediaDeps: MediaDeps | null = null
  private turnHandler: ((event: { type: string; messages: any[] }) => void) | null = null
  private onDown: ((reason: string) => void) | null = null

  constructor(private readonly config: ReadOnlyConfig) {
    super()
  }

  // Called when the personal link drops in a way that needs attention (logged
  // out → re-pair). Used for a liveness alert from the dedicated socket.
  onDisconnect(cb: (reason: string) => void): void {
    this.onDown = cb
  }

  enableMedia(deps: MediaDeps): void {
    this.mediaDeps = deps
  }

  async start(): Promise<void> {
    const sock = await this.connect({
      credsDir: this.config.credsDir,
      number: this.config.personalNumber,
      label: 'personal',
      phone: 'your PERSONAL phone',
      // Never mark the owner online: an "online" linked device suppresses push notifications on their phone.
      socketOpts: { markOnlineOnConnect: false },
      onLoggedOut: () => this.onDown?.('personal link logged out — re-pair needed (history capture is paused)'),
    })

    // Live messages: the same coalescer as the dedicated socket, ingest-only (no respond),
    // so a captioned photo is stored ONCE with its description.
    sock.ev.on('messages.upsert', (event) => {
      if (!this.handler) return
      this.turnHandler ??= createTurnHandler({
        download: mediaDownloader(() => this.sock),
        ingest: this.handler,
        deps: this.mediaDeps ?? NO_MEDIA,
      })
      this.turnHandler(event)
    })

    // History sync pushed on companion pairing — forward each message through
    // the same handler so ingest back-fills recent history.
    sock.ev.on('messaging-history.set', async ({ messages, contacts }: any) => {
      this.reportContacts(contacts) // bulk address book arrives here on connect
      if (!this.handler) return
      for (const m of messages) {
        const inbound = toInbound(m)
        if (inbound) await this.handler(inbound)
      }
    })
  }

  // NOTE: intentionally NO send() method. This is the read-only guarantee.
}
