import { describe, it, expect } from 'vitest'
import { memegenEscape, memeUrl } from '../../src/fun'

describe('memegenEscape', () => {
  it('escapes spaces and specials to memegen codes', () => {
    expect(memegenEscape('hello world')).toBe('hello_world')
    expect(memegenEscape('a_b-c')).toBe('a__b--c')
    expect(memegenEscape('what?')).toBe('what~q')
    expect(memegenEscape('')).toBe('_') // empty → space so the URL segment isn't blank
  })
})

describe('memeUrl', () => {
  it('builds a memegen URL with encoded segments', () => {
    const u = memeUrl('drake', 'writing tests', 'shipping to prod')
    expect(u).toBe('https://api.memegen.link/images/drake/writing_tests/shipping_to_prod.png')
  })
  it('URL-encodes Hebrew and switches to the Hebrew-capable font', () => {
    const u = memeUrl('fry', 'שלום', '')
    expect(u).toContain('/fry/')
    expect(u).toMatch(/%D7/) // Hebrew percent-encoded
    expect(u.endsWith('.png?font=notosanshebrew')).toBe(true) // default Impact font can't render Hebrew
  })
  it('does not add the Hebrew font for Latin-only captions', () => {
    expect(memeUrl('drake', 'no', 'yes')).not.toContain('font=')
  })
  it('strips emoji from captions (they render as tofu on memes)', () => {
    const u = memeUrl('drake', 'ship it 🚀🔥', 'no 😂')
    expect(u).toBe('https://api.memegen.link/images/drake/ship_it/no.png') // emoji + trailing space gone
  })
})
