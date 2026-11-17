export interface InboundMessage {
  id: string
  chatJid: string
  senderJid: string
  senderName?: string
  text: string
  ts: number
  fromMe: boolean
  isGroup?: boolean // chat is a group (@g.us)
  mentionsMe?: boolean // group message that woke the bot (@-mention, reply, name, or 1:1)
  softWake?: boolean // woke ONLY because its name appeared (not @-tagged/replied) — may be talked ABOUT, not TO
}

export interface OutboundMessage {
  chatJid: string
  text: string
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>

export interface Transport {
  onMessage(handler: MessageHandler): void
  send(msg: OutboundMessage): Promise<void>
  start(): Promise<void>
}
