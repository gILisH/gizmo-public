import type { InboundMessage, MessageHandler, OutboundMessage, Transport } from './types'

export class FakeTransport implements Transport {
  sent: OutboundMessage[] = []
  private handler: MessageHandler | null = null

  onMessage(handler: MessageHandler): void {
    this.handler = handler
  }

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg)
  }

  async start(): Promise<void> {}

  // test helper: simulate an incoming message
  async inject(msg: InboundMessage): Promise<void> {
    if (!this.handler) throw new Error('no handler registered')
    await this.handler(msg)
  }
}
