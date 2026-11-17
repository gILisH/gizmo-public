import { describe, it, expect } from 'vitest'
import { openStore } from '../../src/store'
import { makeIngestHandler } from '../../src/ingest/handler'
import { makeSearch } from '../../src/search'
import { OllamaEmbedder } from '../../src/search/embedder'
import type { InboundMessage } from '../../src/transport/types'

// Gated: only runs with GIZMO_OLLAMA_TEST=1 (needs a live Ollama + bge-m3).
// Default test runs stay $0.
const RUN = process.env.GIZMO_OLLAMA_TEST === '1'

const inbound = (id: string, text: string): InboundMessage => ({
  id, chatJid: 'c@s.whatsapp.net', senderJid: 's@s.whatsapp.net',
  senderName: 'Dana', text, ts: 1700000000, fromMe: false,
})

describe.skipIf(!RUN)('bge-m3 integration (real Ollama)', () => {
  it('embeds 1024-dim vectors', async () => {
    const e = new OllamaEmbedder()
    const v = await e.embed('hello')
    expect(v.length).toBe(1024)
  }, 30000)

  it('cross-lingual hybrid search: a Hebrew query finds the English message', async () => {
    const store = openStore(':memory:', { embedDim: 1024 })
    const embedder = new OllamaEmbedder()
    const ingest = makeIngestHandler(store, 'dedicated', embedder)
    await ingest(inbound('a', 'the plumber fixed the leak in the kitchen'))
    await ingest(inbound('b', 'dinner reservation friday at eight'))
    await ingest(inbound('c', 'remember to buy milk and eggs'))

    const { search } = makeSearch(store, embedder)
    // Hebrew: "who fixed the leak?"
    const results = await search('מי תיקן את הנזילה?', { limit: 3 })
    expect(results[0].text).toContain('plumber')
    store.close()
  }, 30000)
})
