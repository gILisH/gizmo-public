import type { Store, StoredMessage } from '../store/types'
import type { Embedder } from './embedder'
import { rrfScored } from './rrf'

export interface Snippet {
  id: string
  text: string
  senderName?: string
  chatName?: string // group/chat name, when known
  ts: number
  chatJid: string
}

export interface SearchOptions {
  limit?: number
  from?: string // only messages whose sender name contains this (case-insensitive)
  after?: number // only messages at/after this unix ts
  before?: number // only messages at/before this unix ts
  chatScope?: string // restrict to this one chat's messages (ACL; omit = all chats)
  excludeSenders?: string[] // drop messages from these senderJids (e.g. the bot's own turns)
  sort?: 'relevance' | 'recent' // order the relevant matches by score (default) or newest-first
  now?: number // "current time" for recency scoring (injectable for tests)
}

const RECENCY_WEIGHT = 0.01 // gentle: a same-day hit gets ~one rank-slot of boost, no more
const EXACT_BONUS = 1.0 // exact-token (FTS) match — dwarfs RRF (~0.03), so it ranks first
const TRIGRAM_BONUS = 0.3 // substring match — above pure-semantic noise, below exact

export function makeSearch(store: Store, embedder: Embedder) {
  return {
    async search(query: string, opts: SearchOptions = {}): Promise<Snippet[]> {
      const limit = opts.limit ?? 10
      const filtering = Boolean(opts.from || opts.after || opts.before || opts.chatScope)
      const allowedChats = opts.chatScope ? new Set([opts.chatScope]) : null
      const k = filtering ? Math.max(limit * 6, 60) : Math.max(limit * 3, 30) // wider pool when filtering
      const vec = await embedder.embed(query)
      const vecIds = store.vecSearch(vec, k).map((r) => r.id)
      const ftsIds = store.ftsSearch(query, k).map((r) => r.id) // exact-token
      const triIds = store.trigramSearch(query, k).map((r) => r.id) // substring → Hebrew morphology
      // Weight semantic 2× — exact-token FTS misses gendered/plural Hebrew forms, so a
      // strong semantic-only hit shouldn't lose to messages FTS happens to token-match.
      const scored = rrfScored([vecIds, ftsIds, triIds], 60, [2, 1, 1])
      const byId = new Map(store.getMessagesByIds(scored.map((s) => s.id)).map((m) => [m.id, m]))
      const now = opts.now ?? Math.floor(Date.now() / 1000)
      const fromLc = opts.from?.toLowerCase()
      // A message that literally contains the query token is unambiguously more relevant
      // than a semantic/substring near-miss. This bonus dwarfs the RRF scores (~0.03), so
      // exact matches always rank first; vec/trigram only fill in below them (or when
      // there's no exact hit at all, e.g. Hebrew morphology). Trigram (substring) gets a
      // smaller boost so partial-word hits beat pure-semantic noise but lose to exact.
      const ftsSet = new Set(ftsIds)
      const triSet = new Set(triIds)

      const ranked = scored
        .map((s) => {
          const m = byId.get(s.id)
          if (!m) return null
          const ageDays = Math.max(0, (now - m.ts) / 86400)
          // Exact tier = the query token (FTS) OR the full query as a substring — the
          // latter catches Hebrew-prefixed forms (query "דיאנה" inside "לדיאנה"/"ודיאנה").
          const exact = ftsSet.has(s.id) || (query.length >= 2 && m.text.includes(query))
          const tier = exact ? 2 : triSet.has(s.id) ? 1 : 0 // exact > partial-substring > semantic-only
          const exactBonus = tier === 2 ? EXACT_BONUS : tier === 1 ? TRIGRAM_BONUS : 0
          return { m, tier, score: s.score + exactBonus + RECENCY_WEIGHT / (1 + ageDays) }
        })
        .filter((x): x is { m: StoredMessage; tier: number; score: number } => x !== null)
        .filter(({ m }) => {
          if (allowedChats && !allowedChats.has(m.chatJid)) return false // ACL: only the asking chat
          if (opts.excludeSenders?.includes(m.senderJid)) return false // e.g. Gizmo's own turns
          if (opts.after && m.ts < opts.after) return false
          if (opts.before && m.ts > opts.before) return false
          if (fromLc) {
            const name = (m.senderName ?? store.getContactName(m.senderJid) ?? '').toLowerCase()
            if (!name.includes(fromLc)) return false
          }
          return true
        })
        // Tier ALWAYS wins (exact > substring > semantic). WITHIN a tier, newest-first
        // by default — an exact match's recency beats BM25 ("what did X say" wants the
        // latest mention, not the shortest). Pass sort='relevance' for best-topical order.
        .sort((a, b) => b.tier - a.tier || (opts.sort === 'relevance' ? b.score - a.score : b.m.ts - a.m.ts))

      // Relevance floor: once ANY lexical match exists (exact token or substring), pure
      // semantic-only hits (tier 0) are noise — they contain nothing the user typed and
      // would just pad the list with newer-but-irrelevant messages. Drop them. With no
      // lexical match at all, keep semantic hits so cross-language/paraphrase still works.
      const hasLexical = ranked.some((r) => r.tier >= 1)

      // Dedupe by canonical sender + text: the same DM message exists as dedicated:X
      // AND personal:X (both sockets), now sharing one canonical senderJid — so this
      // collapses them while keeping genuinely-different people who said the same thing.
      const out: Snippet[] = []
      const seen = new Set<string>()
      for (const { m, tier } of ranked) {
        if (hasLexical && tier === 0) continue // relevance floor
        const key = `${m.senderJid}|${m.text}`.slice(0, 200)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          id: m.id,
          text: m.text,
          senderName: m.senderName ?? store.getContactName(m.senderJid), // resolve "?" senders
          chatName: store.chatLabel(m.chatJid), // group subject, or the 1:1 partner
          ts: m.ts,
          chatJid: m.chatJid,
        })
        if (out.length >= limit) break
      }
      return out
    },
  }
}
