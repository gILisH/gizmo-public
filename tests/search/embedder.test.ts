import { describe, it, expect } from 'vitest'
import { FakeEmbedder, truncateForEmbed, MAX_EMBED_CHARS } from '../../src/search/embedder'

describe('truncateForEmbed', () => {
  it('caps over-long input (prevents bge-m3 context overflow)', () => {
    const long = 'x'.repeat(50_000)
    expect(truncateForEmbed(long).length).toBe(MAX_EMBED_CHARS)
  })
  it('leaves short input untouched', () => {
    expect(truncateForEmbed('hello')).toBe('hello')
  })
})

describe('FakeEmbedder', () => {
  it('returns vectors of the configured dimension', async () => {
    const e = new FakeEmbedder(4)
    expect((await e.embed('hello')).length).toBe(4)
  })

  it('is deterministic — same text yields the same vector', async () => {
    const e = new FakeEmbedder(4)
    expect(await e.embed('hello')).toEqual(await e.embed('hello'))
  })

  it('distinguishes different text', async () => {
    const e = new FakeEmbedder(4)
    expect(await e.embed('hello')).not.toEqual(await e.embed('goodbye'))
  })
})
