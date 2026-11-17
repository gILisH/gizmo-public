import { describe, it, expect } from 'vitest'
import { groupTools } from '../../src/brain/tools/groups'
import type { BrainDeps } from '../../src/brain/types'

const CURRENT = 'dm@s.whatsapp.net'
const GROUP = 'private@g.us'
const call = (t: any, args: any = {}) => t.execute(args, { toolCallId: 't', messages: [] })

function setup(opts: { resolvePhoto?: (q: string, src?: string) => Promise<Buffer | null> } = {}) {
  const calls: any[] = []
  const rec = (name: string) => (...a: any[]) => { calls.push([name, ...a]); return Promise.resolve() }
  let staged: { targetName: string; run: () => Promise<void> } | undefined
  let resolveCalls = 0
  const deps = {
    findGroup: (name?: string) => (name ? undefined : GROUP),
    chatName: () => 'KG&🤖',
    generateImage: rec('generateImage'),
    composeScene: rec('composeScene'),
    sendText: rec('sendText'),
    sendGif: rec('sendGif'),
    sendMeme: rec('sendMeme'),
    sendPoll: rec('sendPoll'),
    resolvePhoto: async (q: string, src?: string) => { resolveCalls++; return opts.resolvePhoto ? opts.resolvePhoto(q, src) : null },
    sendPhotoBytes: (chatJid: string, image: Buffer) => { calls.push(['sendPhotoBytes', chatJid, image]); return Promise.resolve() },
    stagePost: (_c: string, targetName: string, run: () => Promise<void>) => { staged = { targetName, run } },
    confirmPost: async () => { if (!staged) return 'nothing staged'; await staged.run(); return `sent to "${staged.targetName}"` },
    cancelPost: () => (staged ? ((staged = undefined), 'canceled the staged send') : 'nothing was staged'),
  } as unknown as BrainDeps
  const t: any = groupTools(deps, CURRENT, { isOwner: true, chatJid: CURRENT })
  return { t, calls, getStaged: () => staged, resolveCount: () => resolveCalls }
}

describe('post_to_group (unified content, staged + confirmed)', () => {
  it('INVARIANT: nothing is sent until confirm_send — even a full content payload only stages', async () => {
    const { t, calls, getStaged } = setup()
    const out = await call(t.post_to_group, { content: { imagePrompt: 'koh phi phi', people: ['Dan', 'Alex'], text: 'miss you!' } })
    expect(out).toContain('STAGED')
    expect(out).toContain('KG&🤖') // read-back of the resolved group
    expect(calls).toEqual([]) // NO send dep fired — cross-chat cannot bypass the gate
    expect(getStaged()).toBeDefined()
    // only after confirm does anything leave, and it uses REAL faces (composeScene)
    const done = await call(t.confirm_send)
    expect(done).toContain('sent to "KG&🤖"')
    expect(calls).toEqual([
      ['composeScene', GROUP, ['Dan', 'Alex'], 'koh phi phi'],
      ['sendText', GROUP, 'miss you!'],
    ])
  })

  it('supports capabilities parity (e.g. a poll) via content, staged the same way', async () => {
    const { t, calls } = setup()
    await call(t.post_to_group, { content: { poll: { question: 'dinner?', options: ['pizza', 'sushi'] } } })
    expect(calls).toEqual([]) // staged, not sent
    await call(t.confirm_send)
    expect(calls).toEqual([['sendPoll', GROUP, 'dinner?', ['pizza', 'sushi']]])
  })

  it('photo: resolves ONCE, previews to the owner at stage, sends the SAME bytes to the group on confirm', async () => {
    const P = Buffer.from('the-exact-photo-bytes')
    const { t, calls, getStaged, resolveCount } = setup({ resolvePhoto: async () => P })
    const out = await call(t.post_to_group, { content: { photo: 'the photo I just replied to' } })
    expect(out).toContain('PREVIEW')
    expect(out).toContain('STAGED')
    // preview went to the OWNER's chat (from), NOT the group, at stage time
    expect(calls).toEqual([['sendPhotoBytes', CURRENT, P]])
    expect(getStaged()).toBeDefined()
    // confirm → sends the CAPTURED buffer (same ref) to the GROUP; no re-resolve
    await call(t.confirm_send)
    expect(calls).toEqual([
      ['sendPhotoBytes', CURRENT, P], // the preview
      ['sendPhotoBytes', GROUP, P], // the actual send — SAME buffer
    ])
    expect(calls[1][2]).toBe(P) // identical bytes: preview === sent
    expect(resolveCount()).toBe(1) // resolved exactly once, at stage
  })

  it('photo not found → honest failure, does NOT stage (no false confirm, no loop)', async () => {
    const { t, calls, getStaged } = setup({ resolvePhoto: async () => null })
    const out = await call(t.post_to_group, { content: { photo: 'a photo that does not exist' } })
    expect(out).toMatch(/couldn't find that photo/)
    expect(getStaged()).toBeUndefined() // nothing staged
    expect(calls).toEqual([]) // nothing previewed or sent
  })

  it('cancel_send discards the staged send (nothing goes out)', async () => {
    const { t, calls } = setup()
    await call(t.post_to_group, { content: { text: 'hi group' } })
    expect(await call(t.cancel_send)).toMatch(/canceled/)
    expect(calls).toEqual([])
  })

  it('is owner-only (no cross-chat send surface for non-owners)', () => {
    expect(groupTools({} as BrainDeps, CURRENT, { isOwner: false, chatJid: CURRENT })).toEqual({})
  })
})

describe('post_to_group with an ambiguous group name', () => {
  it('returns the options instead of staging a guess', async () => {
    let staged = false
    const deps = {
      findGroup: () => { throw new Error('"Familia" matches more than one group: Familia (…1234); Familia (…9876)') },
      stagePost: () => { staged = true },
    } as unknown as BrainDeps
    const t: any = groupTools(deps, CURRENT, { isOwner: true, chatJid: CURRENT })
    const out = await call(t.post_to_group, { group: 'Familia', content: { text: 'hi' } })
    expect(out).toContain('more than one group')
    expect(staged).toBe(false)
  })
})
