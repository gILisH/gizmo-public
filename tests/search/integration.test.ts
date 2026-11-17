import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openStore } from '../../src/store'
import { makeIngestHandler } from '../../src/ingest/handler'
import { makeSearch } from '../../src/search'
import { FakeEmbedder } from '../../src/search/embedder'
import type { Store } from '../../src/store/types'
import type { InboundMessage } from '../../src/transport/types'

// End-to-end search over a realistic corpus — mixed Hebrew/English, groups + DMs,
// Gizmo's own turns, exact/prefix/substring overlaps, an old-vs-new pair, and a
// two-socket duplicate. Every past bug (recency-vs-tier, dedup, relevance floor,
// chat scope, 1:1 labels, Gizmo inclusion) is a RANKING INTERACTION that tiny unit
// fixtures miss. This file asserts the behaviour a user actually sees in the UI, so
// it's the one thing to run before a deploy. Uses FakeEmbedder (deterministic, no
// Ollama) — the bugs live in the lexical/tier/dedup logic, not embedding quality.

const FAM = 'familia@g.us'
const GROCERY = 'grocery@g.us'
const DAN = '972500000100@s.whatsapp.net'
const ALEX = '972500000200@s.whatsapp.net'
const OMER = '972500000009@s.whatsapp.net'

let store: Store
let search: ReturnType<typeof makeSearch>['search']

const msg = (o: Partial<InboundMessage> & { id: string; chatJid: string; senderJid: string; text: string; ts: number }): InboundMessage => ({
  senderName: undefined, fromMe: false, ...o,
})

beforeAll(async () => {
  store = openStore(':memory:', { embedDim: 4 })
  const embedder = new FakeEmbedder(4)
  const dedicated = makeIngestHandler(store, 'dedicated', embedder)
  const personal = makeIngestHandler(store, 'personal', embedder)

  store.upsertChatName(FAM, 'Familia')
  store.upsertChatName(GROCERY, 'Grocery list')
  store.upsertContact(DAN, 'Dan')
  store.upsertContact(ALEX, 'Alex')
  store.upsertContact(OMER, 'Omer')

  // דיאנה theme (name): old + new exact, a Hebrew-prefixed form, and unrelated noise.
  await dedicated(msg({ id: 'd_old', chatJid: FAM, senderJid: DAN, senderName: 'Dan', text: 'דיברתי עם דיאנה אתמול', ts: 1000 }))
  await dedicated(msg({ id: 'd_new', chatJid: FAM, senderJid: ALEX, senderName: 'Alex', text: 'דיאנה מגיעה מחר', ts: 5000 }))
  await dedicated(msg({ id: 'd_prefix', chatJid: FAM, senderJid: DAN, senderName: 'Dan', text: 'תגידו לדיאנה שהכל טוב', ts: 3000 }))
  await dedicated(msg({ id: 'noise', chatJid: FAM, senderJid: ALEX, senderName: 'Alex', text: 'איזה כיף היה אתמול 🤣', ts: 6000 })) // NEWER, no דיאנה
  // Gizmo's own message mentioning דיאנה, in the group.
  await dedicated(msg({ id: 'giz', chatJid: FAM, senderJid: 'gizmo', senderName: 'Gizmo', text: 'מצאתי הודעות על דיאנה בקבוצה', ts: 4500 }))

  // מלפפון theme (word): two in the grocery group + one in a DM (for scope tests).
  await dedicated(msg({ id: 'c_old', chatJid: GROCERY, senderJid: DAN, senderName: 'Dan', text: 'לקנות מלפפון ועגבניה', ts: 2000 }))
  await dedicated(msg({ id: 'c_new', chatJid: GROCERY, senderJid: DAN, senderName: 'Dan', text: 'מלפפון טרי מהשוק', ts: 4000 }))
  await dedicated(msg({ id: 'c_dm', chatJid: ALEX, senderJid: DAN, senderName: 'Dan', text: 'קוראים לזה מלפפון בעברית', ts: 2500, fromMe: true }))

  // A 1:1 message Dan sent to Omer (for the chat-label test).
  await dedicated(msg({ id: 'dm_david', chatJid: OMER, senderJid: DAN, senderName: 'Dan', text: 'עומר פה בהשוואות חח', ts: 3500, fromMe: true }))

  // Same physical message seen by BOTH sockets → must collapse to one result.
  await dedicated(msg({ id: 'dup', chatJid: FAM, senderJid: DAN, senderName: 'Dan', text: 'מוכר מעיל כחול', ts: 4800 }))
  await personal(msg({ id: 'dup', chatJid: FAM, senderJid: DAN, senderName: 'Dan', text: 'מוכר מעיל כחול', ts: 4800 }))
  ;({ search } = makeSearch(store, embedder))
})

afterAll(() => store.close())

describe('search integration (realistic corpus)', () => {
  it('relevance floor: every result for a word contains that word — no semantic padding', async () => {
    const r = await search('מלפפון', { limit: 15 })
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((x) => x.text.includes('מלפפון'))).toBe(true)
    expect(r.some((x) => x.text.includes('כיף'))).toBe(false) // the newer noise never leaks in
  })

  it('recency wins within the exact tier: newest matching message first', async () => {
    const r = await search('דיאנה', { limit: 15, sort: 'recent' })
    expect(r[0].text).toBe('דיאנה מגיעה מחר') // ts 5000, above the older exact matches
    expect(r.some((x) => x.text.includes('כיף'))).toBe(false)
  })

  it('Hebrew prefix (לדיאנה) counts as an exact match for query דיאנה', async () => {
    const r = await search('דיאנה', { limit: 15 })
    expect(r.some((x) => x.text === 'תגידו לדיאנה שהכל טוב')).toBe(true)
  })

  it('dedupes the same message seen by both sockets', async () => {
    const r = await search('מעיל', { limit: 15 })
    expect(r.filter((x) => x.text === 'מוכר מעיל כחול').length).toBe(1)
  })

  it('chatScope walls a search to one chat — no other chat leaks', async () => {
    const r = await search('מלפפון', { limit: 15, chatScope: GROCERY })
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((x) => x.chatJid === GROCERY)).toBe(true) // the DM 'c_dm' is excluded
  })

  it('names the 1:1 partner as the chat (who a sent message went to)', async () => {
    const [r] = await search('בהשוואות', { limit: 5 })
    expect(r.chatName).toBe('Omer')
  })

  it('includes Gizmo by default, excludes it when asked', async () => {
    const withGizmo = await search('דיאנה', { limit: 15 })
    expect(withGizmo.some((x) => x.senderName === 'Gizmo')).toBe(true)
    const without = await search('דיאנה', { limit: 15, excludeSenders: ['gizmo'] })
    expect(without.some((x) => x.senderName === 'Gizmo')).toBe(false)
  })
})
