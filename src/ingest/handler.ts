import type { InboundMessage, MessageHandler } from '../transport/types'
import type { MessageSource, Store } from '../store/types'
import type { Embedder } from '../search/embedder'

export function makeIngestHandler(
  store: Store,
  source: MessageSource,
  embedder?: Embedder,
  ownerJid?: string, // the feed owner's jid — attributes fromMe messages to them, not the chat partner
  canonicalize?: (jid: string) => string, // @lid → phone jid, so a person has ONE stable id
): MessageHandler {
  return async (msg: InboundMessage) => {
    // A message the owner SENT (fromMe) in a 1:1 has no participant, so senderJid
    // would wrongly be the chat partner (the recipient). Attribute it to the feed
    // owner instead. Drop the pushName so it resolves to the seeded owner label.
    // Otherwise canonicalize the sender so the same person (whether seen via @lid or
    // phone, personal or dedicated socket) collapses to one id.
    const ownAttributed = Boolean(msg.fromMe && ownerJid)
    const senderJid = ownAttributed ? ownerJid! : canonicalize ? canonicalize(msg.senderJid) : msg.senderJid
    const senderName = ownAttributed ? undefined : msg.senderName
    // Namespace the row id by source: the personal read-only socket and the dedicated
    // socket both see the owner↔Gizmo DM with the SAME WhatsApp id but OPPOSITE fromMe.
    // Without this, ON CONFLICT DO NOTHING lets one clobber the other and the dedicated
    // DM loses the user's turns (history becomes all-assistant → confused replies).
    const rowId = `${source}:${msg.id}`
    const isNew = store.ingest({
      id: rowId, chatJid: msg.chatJid, senderJid,
      senderName, text: msg.text, ts: msg.ts,
      fromMe: msg.fromMe, source,
    })
    if (senderName) store.upsertContact(senderJid, senderName)
    // Index for search only on first insert (avoid re-embedding duplicates).
    if (embedder && isNew && msg.text) {
      store.indexMessage(rowId, msg.text, await embedder.embed(msg.text))
    }
  }
}

export function chain(...handlers: MessageHandler[]): MessageHandler {
  return async (msg) => {
    for (const h of handlers) await h(msg)
  }
}
