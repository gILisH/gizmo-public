import { randomUUID } from 'node:crypto'
import type { InboundMessage, MessageHandler } from './transport/types'
import type { Store, StoredMessage } from './store/types'
import type { Config } from './config'
import type { makeBrain } from './brain'
import { isGuestGroup, mayRespond, maySubscribe, searchScope } from './policy'
import { wantsVoiceReply } from './voice/intent'
import { synthesize, toVoiceNote, type TtsConfig } from './voice/tts'

import type { BrainName } from './brain/types'
import { isGroupJid } from './access/jid'
export type { BrainName }
type Responder = ReturnType<typeof makeBrain>

// Everything the reply pipeline needs, injected by the composition root. Pure decision
// helpers (mayRespond/searchScope/wantsVoiceReply) and voice codecs are imported directly;
// only stateful services are injected — which also makes the pipeline unit-testable with
// fakes. `activeBrain` is a GETTER because the owner can flip the model mid-session.
export interface ResponderDeps {
  transport: {
    send(msg: { chatJid: string; text: string }): Promise<void>
    sendPresence(chatJid: string, type: 'composing' | 'recording' | 'paused'): Promise<void>
    sendVoice(chatJid: string, audio: Buffer, seconds?: number): Promise<void>
  }
  brains: Partial<Record<BrainName, Responder>>
  subscription?: Pick<Responder, 'respond'> // Claude via the owner's subscription; tried first when claude is active
  activeBrain: () => BrainName
  hasBrain: boolean
  store: Pick<Store, 'usageToday' | 'getContactName' | 'addChatMembers' | 'recentByChat' | 'addUsage' | 'ingest'>
  isOwner: (jid: string) => boolean
  canonical: (jid: string) => string
  config: Pick<Config, 'allowedGroups' | 'familyGroups' | 'dailyTokenBudget' | 'guestDailyTokenBudget' | 'ownerNames' | 'historyLimit' | 'historyWindowHours' | 'burstGapMinutes'>
  feedOwner: string
  tts: TtsConfig | null
  timeoutMs?: number
}

const BUDGET_MSG = 'הגעתי לתקרת השימוש היומית — נדבר מחר 🙏\n(hit today\'s usage budget — back tomorrow)'
const TROUBLE_MSG = 'אני נתקל בבעיה כרגע, נסה שוב בעוד רגע 🙏\n(I\'m having trouble right now — try again in a bit)'

// Reject a promise that runs past `ms` so a stuck bare fetch (no built-in timeout) can't
// pin the user on "typing…" forever — the caller falls back to the other brain.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

// The reply handler, plus `ask`: a question from Claude Code answered by the same brains,
// budget and fallback, returned to the caller instead of sent to WhatsApp.
export type ReplyPipeline = MessageHandler & { ask(chatJid: string, question: string): Promise<string> }

export function makeResponder(deps: ResponderDeps): ReplyPipeline {
  const { transport, brains, store, config } = deps
  const timeoutMs = deps.timeoutMs ?? 60_000

  const guestChat = (msg: InboundMessage) => isGuestGroup({ isGroup: Boolean(msg.isGroup), chatJid: msg.chatJid, familyGroups: config.familyGroups ?? [] })

  // Should we reply at all, and how? Pure admission decision (no I/O).
  const admit = (msg: InboundMessage): 'skip' | 'echo' | 'budget' | 'go' => {
    if (msg.fromMe) return 'skip'
    if (!deps.hasBrain) return 'echo'
    const groupAllowed = config.allowedGroups.includes(msg.chatJid) // empty allowlist = no groups (fail closed)
    if (!mayRespond({ isGroup: Boolean(msg.isGroup), mentionsMe: Boolean(msg.mentionsMe), isOwner: deps.isOwner(msg.senderJid), groupAllowed })) return 'skip'
    if (store.usageToday() >= config.dailyTokenBudget) return 'budget'
    // A guest group has its own cap too, so strangers can't spend the family's whole day.
    if (guestChat(msg) && store.usageToday(msg.chatJid) >= config.guestDailyTokenBudget) return 'budget'
    return 'go'
  }

  // JID → a name the model knows: curated owner names → address-book contact → push name.
  const nameOf = (jid: string, pushName?: string) =>
    config.ownerNames[deps.canonical(jid)] ?? store.getContactName(jid) ?? pushName

  // Assemble the per-turn options the brain needs (history burst, speaker, ACL scope).
  const buildOpts = (msg: InboundMessage, id: string) => {
    const since = Math.floor(Date.now() / 1000) - config.historyWindowHours * 3600
    const currentId = `dedicated:${msg.id}` // exclude the just-ingested current message
    const history = store.recentByChat(msg.chatJid, config.historyLimit, since).filter((m) => m.id !== currentId)
    const guest = guestChat(msg)
    return {
      isOwner: deps.isOwner(msg.senderJid) && !guest, // in a guest group even the owner is a plain member
      inGroup: Boolean(msg.isGroup),
      guest,
      softWake: Boolean(msg.softWake),
      chatJid: msg.chatJid,
      history,
      speaker: nameOf(msg.senderJid, msg.senderName),
      resolveName: (m: StoredMessage) => nameOf(m.senderJid, m.senderName) ?? m.senderName ?? 'User',
      currentTs: msg.ts,
      burstGapSec: config.burstGapMinutes * 60, // how far back the in-context history burst reaches
      // post_to_group / claude_code / schedule_task stamp it; a confirm in the same turn is refused.
      // A scheduled task's replay gets none: no human typed it, so it can't confirm anything.
      turnId: msg.id.startsWith('sched:') ? '' : randomUUID(),
      // ACL: full-corpus search only for the feed owner in his private DM; any group scopes
      // everyone (owner included) to that group. See policy.ts.
      chatScope: searchScope({ isFeedOwner: id === deps.feedOwner, isGroup: Boolean(msg.isGroup), chatJid: msg.chatJid }),
    }
  }

  // Run the active brain; on error OR timeout, fall through EVERY other brain in turn before
  // giving up (a quota 429, exhausted credits, a transient bad response, or a stuck fetch
  // shouldn't leave the user in silence). Trying only ONE other means an unfunded fallback
  // brain sinks the whole turn even when a third, healthy brain is available.
  // The subscription brain goes first when claude is active and policy allows it
  // (owner's DM / allowed group); a rate limit or auth error falls to the API brains.
  const runWithFallback = async (id: string, text: string, opts: ReturnType<typeof buildOpts> & { fromSandbox?: boolean }) => {
    const active = deps.activeBrain()
    const all: Record<string, Pick<Responder, 'respond'>> = { ...brains }
    const sub = deps.subscription && active === 'claude' && maySubscribe({ isGroup: opts.inGroup, guest: opts.guest, isFeedOwner: id === deps.feedOwner })
    if (sub) all.subscription = deps.subscription!
    const run = (name: string) => withTimeout(all[name].respond(id, text, opts), timeoutMs, name)
    const order = [...(sub ? ['subscription'] : []), active, ...(Object.keys(brains) as BrainName[]).filter((n) => n !== active)]
    let lastErr: unknown
    for (const name of order) {
      try {
        return await run(name)
      } catch (err) {
        lastErr = err
        const next = order[order.indexOf(name) + 1]
        console.error(`${name} failed${next ? `, falling back to ${next}` : ''}:`, (err as Error).message)
      }
    }
    throw lastErr
  }

  // Send the reply as a voice note when asked/needed and TTS is configured, else as text.
  // `setPresence` lets us flip the indicator to "recording…" during TTS.
  const deliver = async (msg: InboundMessage, reply: string, wantVoice: boolean, setPresence: (p: 'recording') => void) => {
    if (!reply.trim()) return
    if (wantVoice && deps.tts) {
      setPresence('recording')
      try {
        const { ogg, seconds } = await toVoiceNote(await synthesize(reply, deps.tts))
        await transport.sendVoice(msg.chatJid, ogg, seconds)
        return
      } catch (ttsErr) {
        console.error('tts error, falling back to text:', (ttsErr as Error).message)
      }
    }
    await transport.send({ chatJid: msg.chatJid, text: reply })
  }

  // Record Gizmo's own reply as an assistant turn — WhatsApp re-emits our sends as 'append'
  // (filtered out on ingest), so without this the history is all-user and breaks
  // alternation. mediaNote captures memes/gifs so a caption-less send still leaves a trace.
  const recordReply = (msg: InboundMessage, reply: string, mediaNote: string) => {
    const recorded = [reply.trim(), mediaNote].filter(Boolean).join(' ')
    if (!recorded) return
    const now = Math.floor(Date.now() / 1000)
    store.ingest({
      id: `gizmo:${msg.chatJid}:${now}:${msg.id.slice(-8)}`,
      chatJid: msg.chatJid, senderJid: 'gizmo', senderName: 'Gizmo',
      text: recorded, ts: now, fromMe: true, source: 'dedicated',
    })
  }

  const handle: MessageHandler = async (msg) => {
    const verdict = admit(msg)
    if (verdict === 'skip') return
    if (verdict === 'echo') return void transport.send({ chatJid: msg.chatJid, text: msg.text })
    if (verdict === 'budget') return void transport.send({ chatJid: msg.chatJid, text: BUDGET_MSG })

    const id = deps.canonical(msg.senderJid)
    if (!msg.isGroup) store.addChatMembers(msg.chatJid, [id]) // a 1:1 DM is owned by its human
    const opts = buildOpts(msg, id)

    // "typing…" while composing (WhatsApp expires it ~10s, so refresh); cleared in finally.
    let presence: 'composing' | 'recording' = 'composing'
    void transport.sendPresence(msg.chatJid, presence)
    const typing = setInterval(() => void transport.sendPresence(msg.chatJid, presence), 6000)
    const stopTyping = () => {
      clearInterval(typing)
      void transport.sendPresence(msg.chatJid, 'paused')
    }
    try {
      const { text, asVoice, reacted, tokens, mediaNote } = await runWithFallback(id, msg.text, opts)
      store.addUsage(tokens, opts.guest ? msg.chatJid : undefined) // count toward the daily budget(s)
      // A reaction is the whole reply — drop any text the model tacked on, keep a trace.
      const reply = reacted ? '' : text
      const note = reacted ? [mediaNote, '[reacted]'].filter(Boolean).join(' ') : mediaNote
      const wantVoice = asVoice || wantsVoiceReply(msg.text) // honor an explicit ask deterministically
      await deliver(msg, reply, wantVoice, (p) => {
        presence = p
        void transport.sendPresence(msg.chatJid, p)
      })
      recordReply(msg, reply, note)
    } catch (err) {
      console.error('brain error:', (err as Error).stack ?? (err as Error).message)
      await transport.send({ chatJid: msg.chatJid, text: TROUBLE_MSG }).catch((e) => console.error('fallback send failed:', (e as Error).message))
    } finally {
      stopTyping()
    }
  }

  // Claude Code asks → Gizmo answers as Dan's assistant in the chat he last talked to it
  // from. Both lines land in the chat history so Gizmo remembers the exchange later; the
// question is stored under sender 'claude-code', which buildConversation labels as the
// worker's, so on Dan's next turn it never reads as something he said.
  // The worker is internet-facing and injectable, so its questions run READ-ONLY (fromSandbox:
  // history tools only — no Google, sends, sandboxes, scheduling or deletes) and search only
  // that chat, never the full corpus.
  let askSeq = 0
  const ask = async (chatJid: string, question: string): Promise<string> => {
    if (store.usageToday() >= config.dailyTokenBudget) throw new Error("Gizmo hit today's usage budget")
    const isGroup = isGroupJid(chatJid)
    const asker: InboundMessage = { id: `cc-ask-${Date.now()}`, chatJid, senderJid: `${deps.feedOwner}@s.whatsapp.net`, text: question, ts: Math.floor(Date.now() / 1000), fromMe: false, isGroup }
    const opts = { ...buildOpts(asker, deps.feedOwner), speaker: 'Claude Code', fromSandbox: true, chatScope: chatJid }
    const prompt = `[Claude Code, on your server, working with Dan, asks you. Answer from what you know; your answer goes back to it, not to the chat, so don't message Claude Code about it.] ${question}`
    const r = await runWithFallback(deps.feedOwner, prompt, opts)
    store.addUsage(r.tokens)
    const now = Math.floor(Date.now() / 1000)
    const key = `cc:${chatJid}:${Date.now()}-${askSeq++}` // unique per ask — two in one second must not collide
    store.ingest({ id: `${key}:q`, chatJid, senderJid: 'claude-code', senderName: 'Claude Code', text: question, ts: now, fromMe: false, source: 'dedicated' })
    store.ingest({ id: `${key}:a`, chatJid, senderJid: 'gizmo', senderName: 'Gizmo', text: r.text, ts: now, fromMe: true, source: 'dedicated' })
    return r.text || '(Gizmo had no answer)'
  }

  // One reply at a time per chat: a turn arriving mid-reply (a correction sent while Gizmo
  // is still working) waits, so it runs with the first reply already in its history.
  const tails = new Map<string, Promise<void>>()
  const queued: MessageHandler = (msg) => {
    const run = (tails.get(msg.chatJid) ?? Promise.resolve()).then(() => handle(msg))
    const tail = run.catch(() => {}) // one failed turn must not wedge the chat
    tails.set(msg.chatJid, tail)
    void tail.then(() => { if (tails.get(msg.chatJid) === tail) tails.delete(msg.chatJid) })
    return run
  }

  return Object.assign(queued, { ask })
}
