import { describe, it, expect } from 'vitest'
import { whatsappTools } from '../../src/brain/tools/whatsapp'
import type { BrainDeps } from '../../src/brain/types'

const CHAT = 'c@s.whatsapp.net'
const call = (t: any, args: any = {}) => t.execute(args, { toolCallId: 't', messages: [] })

// Record every dep invocation; each field present = capability enabled.
function recDeps(enabled: Partial<Record<string, boolean>> = {}) {
  const calls: any[] = []
  const rec = (name: string) => (...a: any[]) => { calls.push([name, ...a]); return Promise.resolve() }
  const d: any = {}
  for (const k of ['sendPoll', 'react', 'sendLocation', 'sendContact', 'replyQuote', 'editLastMessage', 'deleteLastMessage']) {
    if (enabled[k] !== false) d[k] = rec(k)
  }
  return { deps: d as BrainDeps, calls }
}

describe('whatsappTools', () => {
  it('routes each tool to its dep with the current chat', async () => {
    const { deps, calls } = recDeps()
    const t = whatsappTools(deps, CHAT, { chatJid: CHAT })
    await call(t.send_poll, { question: 'dinner?', options: ['pizza', 'sushi'] })
    await call(t.react, { emoji: '❤️' })
    await call(t.send_location, { latitude: 32.07, longitude: 34.79, name: 'TLV' })
    await call(t.send_contact, { name: 'Plumber', phone: '+972501234567' })
    await call(t.reply_quote, { text: 'this one' })
    await call(t.edit_message, { text: 'fixed' })
    await call(t.delete_message, {})
    expect(calls).toEqual([
      ['sendPoll', CHAT, 'dinner?', ['pizza', 'sushi']],
      ['react', CHAT, '❤️'],
      ['sendLocation', CHAT, 32.07, 34.79, 'TLV'],
      ['sendContact', CHAT, 'Plumber', '+972501234567'],
      ['replyQuote', CHAT, 'this one'],
      ['editLastMessage', CHAT, 'fixed'],
      ['deleteLastMessage', CHAT],
    ])
  })

  it('omits a tool when its dep is absent (capability gating)', () => {
    const { deps } = recDeps({ sendPoll: false, react: false })
    const t = whatsappTools(deps, CHAT, { chatJid: CHAT })
    expect(t.send_poll).toBeUndefined()
    expect(t.react).toBeUndefined()
    expect(t.send_location).toBeDefined()
  })

  it('send_location: a place name is geocoded server-side → pin at resolved coords', async () => {
    const { deps, calls } = recDeps()
    ;(deps as any).geocode = async (q: string) => (q.includes('capybara') ? { lat: 7.88, lng: 98.39, label: 'Capybara Cafe, Phuket' } : null)
    const t = whatsappTools(deps, CHAT, { chatJid: CHAT })
    const out = await call(t.send_location, { place: 'capybara cafe phuket' })
    expect(calls).toContainEqual(['sendLocation', CHAT, 7.88, 98.39, 'capybara cafe phuket'])
    expect(out).toMatch(/location sent/)
  })
  it('send_location: geocode miss → a definite message, and NO pin sent (never silent)', async () => {
    const { deps, calls } = recDeps()
    ;(deps as any).geocode = async () => null
    const t = whatsappTools(deps, CHAT, { chatJid: CHAT })
    const out = await call(t.send_location, { place: 'jibberish nowhere' })
    expect(out).toMatch(/couldn't find/)
    expect(calls.some((c) => c[0] === 'sendLocation')).toBe(false)
  })

  it('poll schema enforces 2–12 options', () => {
    const { deps } = recDeps()
    const t: any = whatsappTools(deps, CHAT, { chatJid: CHAT })
    expect(t.send_poll.inputSchema.safeParse({ question: 'q', options: ['only one'] }).success).toBe(false)
    expect(t.send_poll.inputSchema.safeParse({ question: 'q', options: ['a', 'b'] }).success).toBe(true)
  })
})
