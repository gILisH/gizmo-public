import { describe, it, expect } from 'vitest'
import { makeDailyCap, makeChatCap } from '../../src/media/cap'

describe('makeDailyCap — one image budget across every engine', () => {
  it('counts all wrapped engines together and resets the next day', async () => {
    let t = Date.parse('2026-11-14T10:00:00Z')
    const capped = makeDailyCap(2, () => t)
    const gen = capped(async (p: string) => `gen ${p}`)
    const edit = capped(async (_imgs: Buffer[], p: string) => `edit ${p}`)
    expect(await gen('a')).toBe('gen a')
    expect(await edit([], 'b')).toBe('edit b')
    await expect(gen('c')).rejects.toThrow(/daily image limit \(2\)/)
    t += 24 * 3600_000
    expect(await edit([], 'd')).toBe('edit d')
  })
})

describe('makeChatCap — guest groups get their own daily image cap', () => {
  it('counts per limited chat, leaves other chats alone, resets the next day', async () => {
    let t = Date.parse('2026-11-14T10:00:00Z')
    const capped = makeChatCap(1, (chat) => chat.startsWith('guest'), () => t)
    const gen = capped(async (chat: string, p: string) => `${chat}:${p}`)
    expect(await gen('guest1@g.us', 'a')).toBe('guest1@g.us:a')
    await expect(gen('guest1@g.us', 'b')).rejects.toThrow(/daily image limit \(1\)/)
    expect(await gen('guest2@g.us', 'c')).toBe('guest2@g.us:c') // another guest group has its own
    for (const p of ['d', 'e', 'f']) expect(await gen('fam@g.us', p)).toBe(`fam@g.us:${p}`) // family: only the global cap
    t += 24 * 3600_000
    expect(await gen('guest1@g.us', 'g')).toBe('guest1@g.us:g')
  })
})
