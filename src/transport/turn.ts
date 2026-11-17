import type { WAMessage } from 'baileys'
import type { InboundMessage, MessageHandler } from './types'
import { unwrap, toInbound, applyWake, messageMeta } from './baileys-map'
import { mediaKind, ingestOneMedia, type MediaDeps } from '../media'

// Collapse a BURST of WhatsApp messages — a photo and its caption sent as separate
// messages, an album, a label ("this is Yoav") followed by a photo, rapid-fire texts —
// into ONE brain turn. This is the root fix for the recurring "one human action arrives
// as N messages → N replies (often contradictory)" bug class.
//
// Before: a text pass AND a media pass each independently invoked the brain, coordinated
// by best-effort suppressReply flags. Bursts split across the two paths → duplicate
// replies. Now EVERY inbound funnels through a single per-(chat, sender) debounce and
// produces exactly one combined respond() call.
//
// Two races are handled explicitly:
//   1. Burst timing — the debounce window (reset on every message) defines "one turn".
//   2. Slow vision — a media message takes a synchronous HOLD the instant it's seen and
//      releases it only after processing (download + describe can take seconds). The turn
//      won't flush while a hold is outstanding, so a sibling text can't reply before the
//      photo joins the turn.
//
// Ingest is per-message and immediate (history/search must never drop a message); only
// the REPLY is batched. The read-only personal socket doesn't use this — it never replies.
export function createTurnHandler(opts: {
  download: (m: WAMessage) => Promise<Buffer>
  ingest: MessageHandler
  respond?: MessageHandler // absent → ingest only, no replies
  deps: MediaDeps
  botIds?: string[]
  debounceMs?: number
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
}): (event: { type: string; messages: WAMessage[] }) => void {
  const { download, ingest, respond, deps, botIds = [], debounceMs = 1500 } = opts
  const schedule = opts.schedule ?? setTimeout
  const clearTimer = opts.clearTimer ?? clearTimeout
  type Turn = { msgs: InboundMessage[]; holds: number; timer?: ReturnType<typeof setTimeout> }
  const turns = new Map<string, Turn>()
  const keyOf = (chatJid: string, senderJid: string) => `${chatJid}::${senderJid}`
  const turnFor = (key: string) => {
    let t = turns.get(key)
    if (!t) { t = { msgs: [], holds: 0 }; turns.set(key, t) }
    return t
  }

  const arm = (key: string) => {
    const t = turns.get(key)
    if (!t) return
    if (t.timer) clearTimer(t.timer)
    t.timer = schedule(() => flush(key), debounceMs)
  }
  const flush = (key: string) => {
    const t = turns.get(key)
    if (!t || t.holds > 0) return // media still processing → release() re-arms
    turns.delete(key)
    if (!respond || t.msgs.length === 0) return
    void respond(combine(t.msgs)).catch((e) => console.error('turn respond error:', (e as Error).message))
  }
  const addForReply = (inbound: InboundMessage) => {
    if (inbound.fromMe) return // the owner's own echoed sends never start a reply turn
    const key = keyOf(inbound.chatJid, inbound.senderJid)
    turnFor(key).msgs.push(inbound)
    arm(key)
  }
  const release = (key: string) => {
    const t = turns.get(key)
    if (!t) return
    t.holds = Math.max(0, t.holds - 1)
    arm(key)
  }

  return (event) => {
    if (event.type !== 'notify') return
    for (const raw of event.messages) {
      const m = unwrap(raw)
      const meta = messageMeta(m)
      if (!meta) continue
      if (mediaKind(m) && (deps.shouldProcess?.(meta) ?? true)) {
        // Take the hold SYNCHRONOUSLY (before any await) so a sibling text arriving in the
        // same burst can't flush the turn before this photo is processed and added.
        const key = keyOf(meta.chatJid, meta.senderJid)
        turnFor(key).holds++
        void (async () => {
          try {
            const inbound = await ingestOneMedia(m, download, deps, botIds)
            if (inbound) {
              await ingest(inbound)
              addForReply(inbound)
            }
          } catch (e) {
            console.error('media ingest error:', (e as Error).message)
          } finally {
            release(key)
          }
        })()
      } else {
        const inbound = toInbound(m)
        if (!inbound) continue
        applyWake(inbound, m, botIds)
        void ingest(inbound)
        addForReply(inbound)
      }
    }
  }
}

// Merge a turn's buffered messages into one inbound: join their texts, OR the wake flags,
// and inherit the latest message's metadata (id/ts drive history exclusion downstream).
// Dedup by WhatsApp id (belt-and-suspenders against a re-delivered id in a burst), keeping
// the richer text.
function combine(msgs: InboundMessage[]): InboundMessage {
  const byId = new Map<string, InboundMessage>()
  for (const m of msgs) {
    const prev = byId.get(m.id)
    if (!prev || m.text.length > prev.text.length) byId.set(m.id, m)
  }
  const uniq = [...byId.values()]
  const last = uniq[uniq.length - 1]!
  const mentionsMe = uniq.some((m) => m.mentionsMe)
  const hardWake = uniq.some((m) => m.mentionsMe && !m.softWake)
  return {
    ...last,
    text: uniq.map((m) => m.text).filter(Boolean).join('\n'),
    mentionsMe,
    softWake: mentionsMe && !hardWake,
  }
}
