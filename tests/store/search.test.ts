import { describe, it, expect } from 'vitest'
import { openStore } from '../../src/store'
import type { StoredMessage } from '../../src/store/types'

const m = (id: string, text: string): StoredMessage => ({
  id, chatJid: 'c@s.whatsapp.net', senderJid: 's@s.whatsapp.net',
  senderName: 'Dana', text, ts: 1700000000, fromMe: false, source: 'dedicated',
})

describe('store search primitives (dim 4)', () => {
  it('vecSearch returns nearest neighbours in order', () => {
    const s = openStore(':memory:', { embedDim: 4 })
    s.ingest(m('a', 'aaa')); s.indexMessage('a', 'aaa', [1, 0, 0, 0])
    s.ingest(m('b', 'bbb')); s.indexMessage('b', 'bbb', [0, 1, 0, 0])
    s.ingest(m('c', 'ccc')); s.indexMessage('c', 'ccc', [0.9, 0.1, 0, 0])
    const near = s.vecSearch([1, 0, 0, 0], 2).map((r) => r.id)
    expect(near).toEqual(['a', 'c'])
    s.close()
  })

  it('ftsSearch matches keyword (incl. Hebrew tokenization path)', () => {
    const s = openStore(':memory:', { embedDim: 4 })
    s.ingest(m('a', 'the plumber called about the leak')); s.indexMessage('a', 'the plumber called about the leak', [1, 0, 0, 0])
    s.ingest(m('b', 'dinner reservation friday')); s.indexMessage('b', 'dinner reservation friday', [0, 1, 0, 0])
    const hits = s.ftsSearch('plumber', 5).map((r) => r.id)
    expect(hits).toEqual(['a'])
    s.close()
  })

  it('trigramSearch matches Hebrew substrings (מוכר finds מוכרת)', () => {
    const s = openStore(':memory:', { embedDim: 4 })
    s.ingest(m('a', 'אני מוכרת בגדים של גברים')); s.indexMessage('a', 'אני מוכרת בגדים של גברים', [1, 0, 0, 0])
    s.ingest(m('b', 'דינר בשישי')); s.indexMessage('b', 'דינר בשישי', [0, 1, 0, 0])
    expect(s.trigramSearch('מוכר', 5).map((r) => r.id)).toContain('a') // exact-token FTS would miss this
    s.close()
  })

  it('chat names round-trip', () => {
    const s = openStore(':memory:', { embedDim: 4 })
    s.upsertChatName('g@g.us', 'בביצרון')
    expect(s.getChatName('g@g.us')).toBe('בביצרון')
    s.close()
  })

  it('getMessagesByIds preserves ranked order and drops misses', () => {
    const s = openStore(':memory:', { embedDim: 4 })
    s.ingest(m('a', 'aaa')); s.ingest(m('b', 'bbb'))
    const got = s.getMessagesByIds(['b', 'missing', 'a']).map((x) => x.id)
    expect(got).toEqual(['b', 'a'])
    s.close()
  })
})
