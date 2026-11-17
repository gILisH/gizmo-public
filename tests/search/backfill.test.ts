import { describe, it, expect } from 'vitest'
import { openStore } from '../../src/store'
import { backfill } from '../../src/search/backfill'
import { FakeEmbedder, EmbedderUnavailable, OllamaEmbedder } from '../../src/search/embedder'
import type { StoredMessage } from '../../src/store/types'

const m = (id: string, text: string): StoredMessage => ({
  id, chatJid: 'c', senderJid: 's', senderName: 'D', text, ts: 1, fromMe: false, source: 'personal',
})

describe('backfill', () => {
  it('embeds + indexes messages that were stored without an index', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    store.ingest(m('a', 'the plumber called')) // stored, NOT indexed
    store.ingest(m('b', 'dinner friday'))
    expect(store.vecSearch([1, 0, 0, 0], 5).length).toBe(0) // nothing indexed yet

    const n = await backfill(store, new FakeEmbedder(4))
    expect(n).toBe(2)
    expect(store.ftsSearch('plumber', 5).map((r) => r.id)).toEqual(['a'])
    store.close()
  })

  it('does not stall on a message that fails to embed (skips + continues)', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    store.ingest(m('a', 'good one'))
    store.ingest(m('poison', 'boom'))
    store.ingest(m('b', 'another good one'))
    // embedder that throws only for the poison message
    const flaky = {
      dim: 4,
      embed: async (t: string) => {
        if (t === 'boom') throw new Error('the input length exceeds the context length')
        return [1, 0, 0, 0]
      },
    }
    const n = await backfill(store, flaky)
    expect(n).toBe(2) // the two good ones indexed
    // and a second run does not loop forever on the poison message
    expect(await backfill(store, flaky)).toBe(0)
    store.close()
  })

  it('pauses when the embedder is unreachable, and indexes those messages once it is back', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    store.ingest(m('a', 'during the outage'))
    const down = { dim: 4, embed: async () => { throw new EmbedderUnavailable('ollama unreachable: ECONNREFUSED') } }
    expect(await backfill(store, down)).toBe(0)
    expect(await backfill(store, new FakeEmbedder(4))).toBe(1) // not zero-filled — still pending, now indexed for real
    store.close()
  })

  it('OllamaEmbedder reports a connection failure as EmbedderUnavailable', async () => {
    const e = new OllamaEmbedder({ base: 'http://127.0.0.1:1' }) // nothing listens on port 1
    await expect(e.embed('x')).rejects.toBeInstanceOf(EmbedderUnavailable)
  })

  it('is idempotent — a second run indexes nothing new', async () => {
    const store = openStore(':memory:', { embedDim: 4 })
    store.ingest(m('a', 'hello'))
    expect(await backfill(store, new FakeEmbedder(4))).toBe(1)
    expect(await backfill(store, new FakeEmbedder(4))).toBe(0)
    store.close()
  })
})
