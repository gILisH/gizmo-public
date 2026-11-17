import { describe, it, expect } from 'vitest'
import { openStore } from '../../src/store'
import { makeIngestHandler } from '../../src/ingest/handler'
import { makeSearch } from '../../src/search'
import { FakeEmbedder } from '../../src/search/embedder'
import type { InboundMessage } from '../../src/transport/types'

const inbound = (id: string, text: string): InboundMessage => ({
  id, chatJid: 'c@s.whatsapp.net', senderJid: 's@s.whatsapp.net',
  senderName: 'Dana', text, ts: 1700000000, fromMe: false,
})

describe('hybrid search (fake embedder, dim 4)', () => {
  it('indexes on ingest and finds the relevant message', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    const ingest = makeIngestHandler(store, 'dedicated', embedder)

    await ingest(inbound('a', 'the plumber called about the leak in the kitchen'))
    await ingest(inbound('b', 'dinner reservation friday at eight'))
    await ingest(inbound('c', 'remember to buy milk and eggs'))

    const { search } = makeSearch(store, embedder)
    const results = await search('plumber leak', { limit: 3 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('plumber')
    store.close()
  })

  it('dedupes the same message seen by both sockets so it does not eat two slots', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    // Same content, both sockets → stored as dedicated:x AND personal:x (distinct rows).
    await makeIngestHandler(store, 'dedicated', embedder)(inbound('x', 'selling a blue winter coat'))
    await makeIngestHandler(store, 'personal', embedder)(inbound('x', 'selling a blue winter coat'))
    const { search } = makeSearch(store, embedder)
    const matches = (await search('blue coat', { limit: 5 })).filter((r) => r.text.includes('blue winter coat'))
    expect(matches.length).toBe(1) // collapsed to a single result
    store.close()
  })

  it('resolves unknown senders from contacts, names the chat, and honours from/date filters', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    const ingest = makeIngestHandler(store, 'personal', embedder)
    // message with NO senderName, but a contact + chat name exist
    await ingest({ id: 'g1', chatJid: 'grp@g.us', senderJid: 'oron@lid', senderName: undefined, text: 'שולחן למסירה', ts: 1700000000, fromMe: false })
    store.upsertContact('oron@lid', 'Oron')
    store.upsertChatName('grp@g.us', 'בביצרון')
    await ingest({ id: 'g2', chatJid: 'grp@g.us', senderJid: 'guy@lid', senderName: 'Guy', text: 'שולחן ישן', ts: 1600000000, fromMe: false })

    const { search } = makeSearch(store, embedder)
    const all = await search('שולחן', { limit: 5, now: 1700000100 })
    const g1 = all.find((r) => r.text === 'שולחן למסירה')
    expect(g1?.senderName).toBe('Oron') // resolved from contacts
    expect(g1?.chatName).toBe('בביצרון') // chat named

    const filtered = await search('שולחן', { limit: 5, from: 'oron', now: 1700000100 })
    expect(filtered.every((r) => r.text === 'שולחן למסירה')).toBe(true) // from filter narrows to Oron
    const dated = await search('שולחן', { limit: 5, after: 1650000000, now: 1700000100 })
    expect(dated.some((r) => r.text === 'שולחן ישן')).toBe(false) // g2 (ts 1.6e9) excluded by after
    store.close()
  })

  it('names the 1:1 partner as the chat (so you see who a message was sent to/from)', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    // A message I SENT in a 1:1 — chat_jid is the recipient, sender is me.
    await makeIngestHandler(store, 'personal', embedder)({
      id: 'dm', chatJid: '972500000001@s.whatsapp.net', senderJid: 'me@s.whatsapp.net',
      senderName: 'Dan', text: 'עומר פה בהשוואות', ts: 100, fromMe: false,
    })
    store.upsertContact('972500000001@s.whatsapp.net', 'Omer')
    const { search } = makeSearch(store, embedder)
    const [r] = await search('עומר', { limit: 5 })
    expect(r.chatName).toBe('Omer') // the conversation is named after the other party
    store.close()
  })

  it('relevance floor: drops pure-semantic noise when real (lexical) matches exist', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    const ingest = makeIngestHandler(store, 'dedicated', embedder)
    // The word the user searched for — an OLD message.
    await ingest({ id: 'match', chatJid: 'c', senderJid: 's', senderName: 'A', text: 'קניתי מלפפון טרי', ts: 100, fromMe: false })
    // NEWER messages with NO overlap with the query — semantic-embedding noise only.
    await ingest({ id: 'noise1', chatJid: 'c', senderJid: 's', senderName: 'A', text: 'בכיף', ts: 999998, fromMe: false })
    await ingest({ id: 'noise2', chatJid: 'c', senderJid: 's', senderName: 'A', text: '🤣', ts: 999999, fromMe: false })
    const { search } = makeSearch(store, embedder)
    const r = await search('מלפפון', { limit: 15, sort: 'recent' })
    expect(r.map((x) => x.text)).toEqual(['קניתי מלפפון טרי']) // only the real match — no newer junk padding
    store.close()
  })

  it('chatScope limits search to the ONE asking chat (ACL)', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    const ingest = makeIngestHandler(store, 'personal', embedder)
    await ingest({ id: 'g', chatJid: 'grp@g.us', senderJid: 's', senderName: 'A', text: 'plans for the picnic', ts: 100, fromMe: false })
    await ingest({ id: 'p', chatJid: 'dan-dm@lid', senderJid: 's', senderName: 'A', text: 'private picnic note', ts: 200, fromMe: false })
    const { search } = makeSearch(store, embedder)
    // Someone asking IN grp@g.us sees only that group — never Dan's private DM.
    const inGroup = await search('picnic', { limit: 5, chatScope: 'grp@g.us' })
    expect(inGroup.some((r) => r.chatJid === 'grp@g.us')).toBe(true)
    expect(inGroup.some((r) => r.chatJid === 'dan-dm@lid')).toBe(false) // walled off
    store.close()
  })

  it('exact-token matches rank above semantic/substring near-misses', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    const ingest = makeIngestHandler(store, 'dedicated', embedder)
    await ingest({ id: 'exact', chatJid: 'c', senderJid: 's', senderName: 'A', text: 'שלום דיאנה מה שלומך', ts: 100, fromMe: false })
    await ingest({ id: 'noise', chatJid: 'c', senderJid: 's', senderName: 'A', text: 'דנה', ts: 999999, fromMe: false }) // similar, NEWER, but not the word
    const { search } = makeSearch(store, embedder)
    const r = await search('דיאנה', { limit: 5 })
    expect(r[0].text).toContain('דיאנה') // exact wins despite the near-miss being far newer
    store.close()
  })

  it('sort=recent orders relevant matches newest-first', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    const ingest = makeIngestHandler(store, 'dedicated', embedder)
    await ingest({ id: 'old', chatJid: 'c', senderJid: 's', senderName: 'A', text: 'diana note', ts: 100, fromMe: false })
    await ingest({ id: 'new', chatJid: 'c', senderJid: 's', senderName: 'A', text: 'diana update', ts: 200, fromMe: false })
    const { search } = makeSearch(store, embedder)
    const r = await search('diana', { limit: 5, sort: 'recent' })
    expect(r[0].text).toBe('diana update') // newest first, regardless of relevance score
    store.close()
  })

  it('does not re-index duplicates (idempotent ingest)', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    const embedder = new FakeEmbedder(4)
    const ingest = makeIngestHandler(store, 'dedicated', embedder)
    await ingest(inbound('a', 'hello world'))
    await ingest(inbound('a', 'hello world')) // same id again
    expect(store.countMessages()).toBe(1)
    store.close()
  })
})
