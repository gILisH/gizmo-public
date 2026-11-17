import { describe, it, expect } from 'vitest'
import { makePhotoStash } from '../../src/media/photo-stash'

const buf = (s: string) => Buffer.from(s)
const CHAT = 'c@s.whatsapp.net'

describe('makePhotoStash', () => {
  it('returns recent photos oldest→newest, capped', () => {
    const s = makePhotoStash({ max: 2 })
    s.add(CHAT, buf('a')); s.add(CHAT, buf('b')); s.add(CHAT, buf('c'))
    expect(s.get(CHAT).map(String)).toEqual(['b', 'c']) // 'a' dropped by cap
  })

  it('expires photos older than the TTL — no cross-task bleed', () => {
    let t = 0
    const s = makePhotoStash({ ttlMs: 60_000, now: () => t })
    s.add(CHAT, buf('old-task')) // t=0: leftover from an earlier flow
    t = 90_000 // 90s later: new enrollment starts
    s.add(CHAT, buf('itai'))
    // the 90s-old photo must NOT come back — only the fresh one
    expect(s.get(CHAT).map(String)).toEqual(['itai'])
  })

  it('clear() empties the chat', () => {
    const s = makePhotoStash()
    s.add(CHAT, buf('a'))
    s.clear(CHAT)
    expect(s.get(CHAT)).toEqual([])
  })
})
