import { describe, it, expect } from 'vitest'
import { toolResult } from '../src/brain'

describe('toolResult — a network tool failure returns text, never aborts the turn', () => {
  it('passes success through unchanged', async () => {
    expect(await toolResult(async () => 'page text here', "couldn't read that page")).toBe('page text here')
  })
  it('turns a throw into a readable string (so the brain keeps going)', async () => {
    const out = await toolResult(async () => { throw new Error('jina reader 403: forbidden') }, "couldn't read that page")
    expect(out).toContain("couldn't read that page")
    expect(out).toContain('jina reader 403')
  })
})
