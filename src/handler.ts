import type { MessageHandler, Transport } from './transport/types'

export function makeEchoHandler(transport: Transport): MessageHandler {
  return async (msg) => {
    if (msg.fromMe) return
    await transport.send({ chatJid: msg.chatJid, text: msg.text })
  }
}
