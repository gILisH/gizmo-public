import { describe, it, expect } from 'vitest'
import { composeOutbound, outboundContentSchema } from '../../src/brain/tools/outbound'
import type { BrainDeps } from '../../src/brain/types'

const T = 'group@g.us'

function recDeps() {
  const calls: any[] = []
  const rec = (n: string) => (...a: any[]) => { calls.push([n, ...a]); return Promise.resolve() }
  const deps = {
    sendText: rec('sendText'), sendMeme: rec('sendMeme'), sendGif: rec('sendGif'),
    sendVoiceNote: rec('sendVoiceNote'), generateImage: rec('generateImage'), composeScene: rec('composeScene'),
    sendPoll: rec('sendPoll'), sendLocation: rec('sendLocation'), sendContact: rec('sendContact'),
    sendSavedPhoto: rec('sendSavedPhoto'),
  } as unknown as BrainDeps
  return { deps, calls }
}
const run = async (deps: BrainDeps, c: any) => { const t = composeOutbound(deps, T, c); if (t) await t(); return t }

describe('composeOutbound', () => {
  it('empty content → null (nothing to send)', () => {
    expect(composeOutbound(recDeps().deps, T, {})).toBeNull()
  })
  it('routes every capability to its dep, always at the target jid', async () => {
    const { deps, calls } = recDeps()
    await run(deps, {
      text: 'hi', meme: { template: 'drake', top: 'a', bottom: 'b' }, gif: 'facepalm',
      poll: { question: 'q', options: ['x', 'y'] }, location: { latitude: 1, longitude: 2, name: 'TLV' },
      contact: { name: 'Plumber', phone: '+972501234567' },
    })
    expect(calls).toEqual([
      ['sendText', T, 'hi'],
      ['sendMeme', T, 'drake', 'a', 'b'],
      ['sendGif', T, 'facepalm'],
      ['sendPoll', T, 'q', ['x', 'y']],
      ['sendLocation', T, 1, 2, 'TLV'],
      ['sendContact', T, 'Plumber', '+972501234567'],
    ])
  })
  it('imagePrompt WITH people → composeScene (real faces), never generateImage', async () => {
    const { deps, calls } = recDeps()
    await run(deps, { imagePrompt: 'on the moon', people: ['Dan', 'Alex'] })
    expect(calls).toEqual([['composeScene', T, ['Dan', 'Alex'], 'on the moon']])
  })
  it('imagePrompt WITHOUT people → generic generateImage', async () => {
    const { deps, calls } = recDeps()
    await run(deps, { imagePrompt: 'a sunset' })
    expect(calls).toEqual([['generateImage', T, 'a sunset']])
  })
  it('does NOT handle photo — post_to_group resolves + previews + captures it specially', async () => {
    const { deps, calls } = recDeps()
    const t = composeOutbound(deps, T, { photo: 'the beach photo' })
    expect(t).toBeNull() // photo alone → nothing for composeOutbound to send
    expect(calls).toEqual([]) // never re-resolves here
  })
  it('voice:true speaks text instead of sending it', async () => {
    const { deps, calls } = recDeps()
    await run(deps, { text: 'good morning', voice: true })
    expect(calls).toEqual([['sendVoiceNote', T, 'good morning']])
  })
  it('poll schema enforces 2–12 options', () => {
    expect(outboundContentSchema.safeParse({ poll: { question: 'q', options: ['one'] } }).success).toBe(false)
    expect(outboundContentSchema.safeParse({ poll: { question: 'q', options: ['a', 'b'] } }).success).toBe(true)
  })
})
