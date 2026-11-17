import { describe, it, expect } from 'vitest'
import { rrfMerge } from '../../src/search/rrf'

describe('rrfMerge', () => {
  it('ranks an id appearing high in both lists above one high in only one', () => {
    const vec = ['x', 'a', 'b']
    const fts = ['a', 'y', 'b']
    const merged = rrfMerge([vec, fts])
    expect(merged[0]).toBe('a') // top-ish in both
  })

  it('handles ids missing from a list', () => {
    const merged = rrfMerge([['a'], ['b']])
    expect(merged.sort()).toEqual(['a', 'b'])
  })

  it('returns empty for empty input', () => {
    expect(rrfMerge([])).toEqual([])
  })
})
