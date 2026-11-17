import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemory } from '../../src/memory'
import { buildSystem, buildTools, makeBrain, parseDayRange, toWhatsAppMarkup, buildConversation, mediaNoteFromSteps, ageLabel, rosterLine, soulFor } from '../../src/brain'
import type { StoredMessage } from '../../src/store/types'
import type { BrainDeps } from '../../src/brain'
import type { Snippet } from '../../src/search'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gizmo-brain-')) })

const fakeSearch = async (): Promise<Snippet[]> => [
  { id: 'x', text: 'the plumber comes tuesday', senderName: 'Dana', ts: 1700000000, chatJid: 'c' },
]

const fakeRecent = (limit: number, opts?: { fromMe?: boolean }) =>
  [
    { id: 'r', chatJid: 'c', senderJid: 's', senderName: 'Me', text: 'my latest note', ts: 1700009999, fromMe: true, source: 'personal' as const },
  ].filter((m) => (opts?.fromMe === undefined ? true : m.fromMe === opts.fromMe)).slice(0, limit)

const fakeRange = (fromTs: number, toTs: number, _limit: number) =>
  [
    { id: 'd', chatJid: 'c', senderJid: 's', senderName: 'Dana', text: 'trip on the 10th', ts: 1717000000, fromMe: false, source: 'personal' as const },
  ].filter((m) => m.ts >= fromTs && m.ts <= toTs)

const deps = (memory: ReturnType<typeof openMemory>): BrainDeps => ({
  model: {} as any, // not used by the unit tests below
  memory,
  search: fakeSearch,
  recent: fakeRecent,
  oldest: (limit: number) => [
    { id: 'o', chatJid: 'c', senderJid: 's', senderName: 'Dana', text: 'the very first message', ts: 1000000000, fromMe: false, source: 'personal' as const },
  ].slice(0, limit),
  range: fakeRange,
  pageChat: (_c: string, offset: number, limit: number) =>
    Array.from({ length: limit }, (_, i) => ({
      id: `p${offset + i}`, chatJid: 'c', senderJid: 's', senderName: 'Gil',
      text: `old message #${offset + i}`, ts: 1000 + offset + i, fromMe: false, source: 'personal' as const,
    })),
  setReminder: () => {},
  sendText: async () => {},
  sendMeme: async () => {},
  sendGif: async () => {},
  householdGroup: () => 'fam@g.us',
  findGroup: (name?: string) => (name ? undefined : 'fam@g.us'),
  chatName: () => 'Familia',
  stagePost: () => {},
  confirmPost: async () => 'sent',
  cancelPost: () => 'canceled',
  soul: 'You are Gizmo.',
})

describe('brain building blocks', () => {
  it('buildSystem injects the speakers own memory + current date into the soul', () => {
    const mem = openMemory(root)
    mem.addFact('alice', 'prefers Hebrew')
    const sys = buildSystem(deps(mem), 'alice', new Date(2026, 5, 10)) // 2026-06-10
    expect(sys).toContain('You are Gizmo.')
    expect(sys).toContain('prefers Hebrew')
    expect(sys).toContain('Current date: 2026-06-10')
  })

  it('names the current speaker so the model does not guess who it is replying to', () => {
    const mem = openMemory(root)
    const inGroup = buildSystem(deps(mem), 'alice', new Date(2026, 5, 10), { name: 'Dan', inGroup: true })
    expect(inGroup).toContain('You are currently talking to Dan (in a group).')
    const dm = buildSystem(deps(mem), 'alice', new Date(2026, 5, 10), { name: 'Dan', inGroup: false })
    expect(dm).toContain('You are currently talking to Dan.')
    const anon = buildSystem(deps(mem), 'alice', new Date(2026, 5, 10)) // no speaker → no line
    expect(anon).not.toContain('currently talking to')
  })

  it('remember tool writes ONLY the bound speakers memory (no destination field)', async () => {
    const mem = openMemory(root)
    const tools = buildTools(deps(mem), 'alice')
    // schema has only `fact` — no user/id/destination to spoof
    expect(Object.keys((tools.remember as any).inputSchema.shape)).toEqual(['fact'])
    await (tools.remember as any).execute({ fact: 'owns billing' }, { toolCallId: 't', messages: [] })
    expect(mem.loadFacts('alice')).toContain('owns billing')
    expect(mem.loadFacts('bob')).toBe('') // never leaks to another speaker
  })

  it('searchHistory tool formats corpus hits', async () => {
    const mem = openMemory(root)
    const tools = buildTools(deps(mem), 'alice')
    const out = await (tools.searchHistory as any).execute({ query: 'plumber' }, { toolCallId: 't', messages: [] })
    expect(out).toContain('plumber comes tuesday')
    expect(out).toContain('Dana')
  })

  it('recentMessages tool returns time-ordered messages (fixes the "last message" gap)', async () => {
    const mem = openMemory(root)
    const tools = buildTools(deps(mem), 'alice')
    const out = await (tools.recentMessages as any).execute({ limit: 5, onlyMine: true }, { toolCallId: 't', messages: [] })
    expect(out).toContain('my latest note')
  })

  it('oldest_messages tool surfaces the earliest message (deep history)', async () => {
    const mem = openMemory(root)
    const tools = buildTools(deps(mem), 'alice')
    const out = await (tools.oldest_messages as any).execute({ limit: 5 }, { toolCallId: 't', messages: [] })
    expect(out).toContain('the very first message')
  })

  it('exposes web_search only when a webSearch dep is provided (works on any brain)', async () => {
    const mem = openMemory(root)
    expect((buildTools(deps(mem), 'alice') as any).web_search).toBeUndefined() // not wired
    const withWeb = buildTools({ ...deps(mem), webSearch: async (q: string) => `results for ${q}` }, 'alice')
    const out = await (withWeb.web_search as any).execute({ query: 'weather tlv' }, { toolCallId: 't', messages: [] })
    expect(out).toBe('results for weather tlv')
  })

  it('generate_image is present when wired; set_avatar is owner-only', async () => {
    const mem = openMemory(root)
    const sent: any = {}
    const d = {
      ...deps(mem),
      generateImage: async (chatJid: string, prompt: string) => { sent.gen = { chatJid, prompt } },
      setAvatar: async (o: { chatJid: string; description?: string }) => `avatar:${o.description ?? 'photo'}`,
    }
    // generate_image: available to anyone
    const t = buildTools(d, 'bob', { isOwner: false, chatJid: 'c' })
    await (t.generate_image as any).execute({ prompt: 'a dragon' }, { toolCallId: 't', messages: [] })
    expect(sent.gen).toEqual({ chatJid: 'c', prompt: 'a dragon' })
    expect((t as any).set_avatar).toBeUndefined() // non-owner: no avatar control
    // set_avatar: owner only
    const owner = buildTools(d, 'dan', { isOwner: true, chatJid: 'dm' })
    expect(await (owner.set_avatar as any).execute({ description: 'a robot' }, { toolCallId: 't', messages: [] })).toBe('avatar:a robot')
  })

  it('switch_model is owner-only and calls switchBrain', async () => {
    const mem = openMemory(root)
    const d = { ...deps(mem), switchBrain: (name: 'claude' | 'gemini' | 'grok') => `now running on ${name}` }
    expect((buildTools(d, 'bob', { isOwner: false }) as any).switch_model).toBeUndefined()
    const owner = buildTools(d, 'dan', { isOwner: true })
    expect(await (owner.switch_model as any).execute({ model: 'grok' }, { toolCallId: 't', messages: [] })).toBe('now running on grok')
  })

  it('scopes history tools to the asking chat when a chatScope is set', async () => {
    const mem = openMemory(root)
    let opts: any
    const d = { ...deps(mem), search: async (_q: string, o: any) => { opts = o; return [] } }
    await (buildTools(d, 'alex', { chatScope: 'grp@g.us' }).searchHistory as any).execute({ query: 'x' }, { toolCallId: 't', messages: [] })
    expect(opts.chatScope).toBe('grp@g.us') // restricted to the group being asked in
    await (buildTools(d, 'dan', {}).searchHistory as any).execute({ query: 'x' }, { toolCallId: 't', messages: [] })
    expect(opts.chatScope).toBeUndefined() // feed owner: no scope → everything
  })

  it('SAFETY: group-memory writes go ONLY to the chat the message came from', async () => {
    const mem = openMemory(root)
    const d = deps(mem)
    const inA: any = buildTools(d, 'dan', { inGroup: true, chatJid: 'A@g.us' })
    // The model supplies only the fact/list — never a target group.
    await inA.remember_group.execute({ fact: 'added in A' }, { toolCallId: 't', messages: [] })
    await inA.revise_family_memory.execute({ facts: ['revised in A'] }, { toolCallId: 't', messages: [] })
    expect(mem.loadGroupFacts('A@g.us')).toContain('revised in A') // wrote to the origin chat
    expect(mem.loadGroupFacts('B@g.us')).toBe('') // another group is untouchable — no param to target it
    // And outside a group, the group-memory tools don't exist at all.
    const inDM: any = buildTools(d, 'dan', { inGroup: false, chatJid: 'dan-dm@lid' })
    expect(inDM.remember_group).toBeUndefined()
    expect(inDM.revise_family_memory).toBeUndefined()
  })

  it('merges per-speaker extraTools; Google gated by owner AND not-in-group', () => {
    const mem = openMemory(root)
    // mirrors the app closure: Google only for owner in a 1:1 (never in-group)
    const extraTools = ({ isOwner, inGroup }: { id: string; isOwner: boolean; inGroup: boolean }) => ({
      web_search: { marker: 'web' },
      ...(isOwner && !inGroup ? { gmail_search: { marker: 'gmail' } } : {}),
    })
    const dm = buildTools({ ...deps(mem), extraTools }, 'alice', { isOwner: true, inGroup: false })
    expect((dm as any).web_search).toEqual({ marker: 'web' })
    expect((dm as any).gmail_search).toEqual({ marker: 'gmail' }) // owner in DM gets Google

    const inGroup = buildTools({ ...deps(mem), extraTools }, 'alice', { isOwner: true, inGroup: true })
    expect((inGroup as any).web_search).toEqual({ marker: 'web' }) // web still there
    expect((inGroup as any).gmail_search).toBeUndefined() // NO Google in a group (partner present)

    const family = buildTools({ ...deps(mem), extraTools }, 'bob', { isOwner: false, inGroup: false })
    expect((family as any).gmail_search).toBeUndefined() // non-owner never gets Google
  })

  it('fetch_earlier_messages tool pages back this chat by offset', async () => {
    const mem = openMemory(root)
    const tools = buildTools(deps(mem), 'alice', { chatJid: 'c' })
    const out = await (tools.fetch_earlier_messages as any).execute({ skip: 15, limit: 25 }, { toolCallId: 't', messages: [] })
    expect(out).toContain('old message #15') // starts after the 15 it already has
    expect(out).toContain('old message #39') // through 16–40 back
  })

  it('post_to_group is owner-only and STAGES the send (does not send until confirmed)', async () => {
    const mem = openMemory(root)
    const sent: any[] = []
    let staged: { run: () => Promise<void> } | undefined
    const d = {
      ...deps(mem),
      sendText: async (jid: string, text: string) => { sent.push({ jid, text }) },
      stagePost: (_c: string, _n: string, run: () => Promise<void>) => { staged = { run } },
    }
    // non-owner: tool absent
    expect((buildTools(d, 'bob', { isOwner: false }) as any).post_to_group).toBeUndefined()
    const tools = buildTools(d, 'dan', { isOwner: true, chatJid: 'dm@s.whatsapp.net' })
    const out = await (tools.post_to_group as any).execute({ content: { text: 'dinner at 8' } }, { toolCallId: 't', messages: [] })
    expect(out).toContain('STAGED') // asks for confirmation, names the group
    expect(out).toContain('Familia')
    expect(sent).toEqual([]) // NOTHING sent yet
    // the staged thunk sends to the group jid (not the DM) once run
    await staged!.run()
    expect(sent).toEqual([{ jid: 'fam@g.us', text: 'dinner at 8' }])
  })

  it('set_reminder tool stores a reminder for this chat (parsing ISO time)', async () => {
    const mem = openMemory(root)
    const saved: any[] = []
    const tools = buildTools({ ...deps(mem), setReminder: (r) => saved.push(r) }, 'alice', { chatJid: 'chat@x' })
    const out = await (tools.set_reminder as any).execute({ text: 'call the vet', whenISO: '2026-07-04T09:00:00+03:00' }, { toolCallId: 't', messages: [] })
    expect(out).toContain('reminder set')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ chatJid: 'chat@x', ownerId: 'alice', text: 'call the vet' })
    expect(saved[0].dueTs).toBeGreaterThan(0)
  })

  it('messagesByDate tool queries the date range', async () => {
    const mem = openMemory(root)
    const tools = buildTools(deps(mem), 'alice')
    // 1717000000 = 2024-05-29 UTC — cover it with a wide range
    const out = await (tools.messagesByDate as any).execute({ from: '2024-05-01', to: '2024-06-30' }, { toolCallId: 't', messages: [] })
    expect(out).toContain('trip on the 10th')
  })
})

describe('toWhatsAppMarkup', () => {
  it('converts markdown bold to WhatsApp bold (single asterisk)', () => {
    expect(toWhatsAppMarkup('sent on **June 10**')).toBe('sent on *June 10*')
  })
  it('leaves WhatsApp-style single-asterisk bold untouched', () => {
    expect(toWhatsAppMarkup('*hello*')).toBe('*hello*')
  })
  it('strips markdown headers and stray double-asterisks', () => {
    expect(toWhatsAppMarkup('## Title\nok **')).toBe('Title\nok ')
  })
})

describe('buildConversation (continuity)', () => {
  const sm = (over: Partial<StoredMessage>): StoredMessage => ({
    id: 'x', chatJid: 'c', senderJid: 's', senderName: 'Gil', text: 't', ts: 1, fromMe: false, source: 'dedicated', ...over,
  })
  it('maps fromMe→assistant, others→user, and appends the current turn last', () => {
    const hist = [sm({ text: 'find the plumber msg', fromMe: false }), sm({ text: 'here it is: ...', fromMe: true })]
    const conv = buildConversation(hist, 'try again', false)
    expect(conv.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(conv[0].content).toBe('find the plumber msg') // no name prefix in DM
    expect(conv[2].content).toBe('try again') // current turn is the final user message
  })
  it('prefixes speaker names in groups', () => {
    const conv = buildConversation([sm({ text: 'hi', senderName: 'Alex', fromMe: false })], 'yo', true)
    expect(conv[0].content).toContain('Alex: hi') // group turns carry the speaker name
  })
  it('resolves history speaker names in a group (JID→known name), falling back to push name', () => {
    const hist = [
      sm({ text: 'sup', senderJid: 'dan@lid', senderName: 'dan🍍', fromMe: false }),
      sm({ text: 'hey', senderJid: 'random@s.whatsapp.net', senderName: 'Dana', fromMe: false }),
    ]
    const resolveName = (m: StoredMessage) => (m.senderJid === 'dan@lid' ? 'Dan' : m.senderName ?? 'User')
    const conv = buildConversation(hist, 'yo', true, 'Dan', resolveName)
    expect(conv[0].content).toContain('Dan: sup') // owner JID mapped to known name
    expect(conv[0].content).toContain('Dana: hey') // non-owner keeps push name
    expect(conv[0].content).not.toContain('dan') // raw push handle never shown for a mapped owner
  })
  it('labels the CURRENT turn with the speaker in a group, raw in a DM', () => {
    expect(buildConversation([], 'send memes', true, 'Dan').at(-1)?.content).toBe('Dan: send memes')
    expect(buildConversation([], 'send memes', false, 'Dan').at(-1)?.content).toBe('send memes') // DM: unambiguous, no prefix
    expect(buildConversation([], 'send memes', true).at(-1)?.content).toBe('send memes') // no speaker known → raw
  })
  it('coalesces consecutive same-role turns', () => {
    const conv = buildConversation([sm({ text: 'a', fromMe: false }), sm({ text: 'b', fromMe: false })], 'c', false)
    expect(conv).toHaveLength(1) // a+b+c all user → merged
    expect(conv[0].content).toBe('a\nb\nc')
  })
  it('KEEPS older context across a gap but MARKS the boundary, and tags the current turn [now]', () => {
    const t0 = 1_700_000_000
    const hist = [
      sm({ text: 'send me a meme', ts: t0, fromMe: false }),
      sm({ text: 'what do you know about my family?', ts: t0 + 60, fromMe: false }),
    ]
    const now = t0 + 60 + 84 * 60 // 84-min gap before the current message
    const conv = buildConversation(hist, '[document: image.png]', false, undefined, undefined, now)
    const all = conv.map((c) => c.content).join('\n')
    expect(all).toContain('family') // old context KEPT, not amputated
    expect(all).toMatch(/— \d+[mhd] later —/) // the gap is made visible
    expect(all).toContain('[now] [document: image.png]') // current turn tagged
  })
  it('keeps rapid-fire messages within the burst window, each stamped with its age', () => {
    const t0 = 1_700_000_000
    const hist = [sm({ text: 'wait', ts: t0, fromMe: false }), sm({ text: 'actually', ts: t0 + 30, fromMe: false })]
    const conv = buildConversation(hist, 'this', false, undefined, undefined, t0 + 90) // all within 30min
    expect(conv).toHaveLength(1) // coalesced together — same ask
    expect(conv[0].content).toContain('wait')
    expect(conv[0].content).toContain('actually')
    expect(conv[0].content).toContain('[now] this') // current message clearly marked
    expect(conv[0].content).toMatch(/\d+m ago|just now/) // age labels present
  })
  it('drops a leading assistant turn (must start with user)', () => {
    const conv = buildConversation([sm({ text: 'earlier bot line', fromMe: true })], 'hello', false)
    expect(conv[0].role).toBe('user')
    expect(conv).toHaveLength(1)
  })
})

describe('parseDayRange', () => {
  it('single date spans that whole local day', () => {
    const [from, to] = parseDayRange('2026-06-10')
    expect(to - from).toBe(86399) // 23:59:59 - 00:00:00
  })
  it('range spans from start-of-from to end-of-to', () => {
    const [from, to] = parseDayRange('2026-06-01', '2026-06-03')
    expect(to - from).toBeGreaterThan(2 * 86400) // ~3 days
  })
})

describe('brain respond (mock model, no tool call)', () => {
  it('returns the models text with memory injected as system', async () => {
    const { MockLanguageModelV4 } = await import('ai/test')
    const mem = openMemory(root)
    mem.addFact('alice', 'prefers Hebrew')
    let seenSystem = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (opts: any) => {
        seenSystem = JSON.stringify(opts.prompt)
        return {
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: 'text', text: 'שלום' }],
          warnings: [],
        } as any
      },
    })
    const brain = makeBrain({ ...deps(mem), model: model as any })
    const reply = await brain.respond('alice', 'hi')
    expect(reply.text).toBe('שלום')
    expect(reply.asVoice).toBe(false) // no reply_as_voice tool call in this run
    expect(seenSystem).toContain('prefers Hebrew') // per-speaker memory reached the model
  })
})

describe('ageLabel', () => {
  it('gives human ages across scales so the model never calculates', () => {
    expect(ageLabel(3)).toBe('just now')
    expect(ageLabel(45)).toBe('45s ago')
    expect(ageLabel(5 * 60)).toBe('5m ago')
    expect(ageLabel(3 * 3600)).toBe('3h ago')
    expect(ageLabel(2 * 86400)).toBe('2d ago')
    expect(ageLabel(400 * 86400)).toBe('1y ago')
  })
})

describe('mediaNoteFromSteps', () => {
  it('describes memes and gifs from tool-call args, ignores other tools', () => {
    const steps = [
      { toolCalls: [{ toolName: 'send_meme', input: { template: 'drake', top: 'no history', bottom: 'with history' } }] },
      { toolCalls: [{ toolName: 'send_gif', input: { query: 'mic drop' } }, { toolName: 'remember', input: { fact: 'x' } }] },
    ]
    expect(mediaNoteFromSteps(steps)).toBe('[meme: drake — no history / with history] [gif: mic drop]')
  })

  it('omits the caption dash when a meme has no text, and returns empty with no media', () => {
    expect(mediaNoteFromSteps([{ toolCalls: [{ toolName: 'send_meme', input: { template: 'aliens', top: '', bottom: '' } }] }])).toBe('[meme: aliens]')
    expect(mediaNoteFromSteps([{ toolCalls: [{ toolName: 'searchHistory', input: { query: 'q' } }] }])).toBe('')
  })
})

describe('read_self_chat — owner enumerates their own self-chat (the SELECT-WHERE-chat primitive)', () => {
  const withPageChat = (mem: ReturnType<typeof openMemory>, rows: StoredMessage[]): BrainDeps => ({
    ...deps(mem),
    pageChat: (chatJid: string, _o: number, _l: number) => rows.map((r) => ({ ...r, chatJid })),
  })
  const rows: StoredMessage[] = [
    { id: 'a', chatJid: 'x', senderJid: 's', senderName: 'Me', text: 'plain note to self', ts: 1, fromMe: true, source: 'personal' },
    { id: 'b', chatJid: 'x', senderJid: 's', senderName: 'Me', text: 'check https://x.com/foo', ts: 2, fromMe: true, source: 'personal' },
    { id: 'c', chatJid: 'x', senderJid: 's', senderName: 'Me', text: 'http://youtu.be/bar cool', ts: 3, fromMe: true, source: 'personal' },
  ]

  it('is owner-only (absent for non-owners)', () => {
    const mem = openMemory(root)
    expect((buildTools(withPageChat(mem, rows), 'alice', { isOwner: false }) as any).read_self_chat).toBeUndefined()
    expect((buildTools(withPageChat(mem, rows), 'alice', { isOwner: true }) as any).read_self_chat).toBeDefined()
    expect((buildTools(withPageChat(mem, rows), 'alice', { isOwner: true, inGroup: true, chatJid: 'fam@g.us' }) as any).read_self_chat).toBeUndefined() // DM only
  })

  it('pages the owner self-chat jid (phone@s.whatsapp.net) and returns all messages', async () => {
    const mem = openMemory(root)
    const tools = buildTools(withPageChat(mem, rows), '972500000100', { isOwner: true })
    const out = await (tools.read_self_chat as any).execute({}, { toolCallId: 't', messages: [] })
    expect(out).toContain('plain note to self')
    expect(out).toContain('https://x.com/foo')
  })

  it('links_only filters to messages containing a URL', async () => {
    const mem = openMemory(root)
    const tools = buildTools(withPageChat(mem, rows), '972500000100', { isOwner: true })
    const out = await (tools.read_self_chat as any).execute({ links_only: true }, { toolCallId: 't', messages: [] })
    expect(out).toContain('https://x.com/foo')
    expect(out).toContain('http://youtu.be/bar')
    expect(out).not.toContain('plain note to self')
  })
})

describe('face library — enroll_person / create_scene / roster', () => {
  const peopleDeps = (mem: ReturnType<typeof openMemory>, calls: any[]): BrainDeps => ({
    ...deps(mem),
    listPeople: () => [
      { id: 'itai', names: ['Itai'], relation: "Alex's nephew", count: 2 },
      { id: 'rita', names: ['Tova', 'savta', 'סבתא'], relation: "Alex's mom", count: 1 },
    ],
    enrollPerson: async (_c: string, name: string, opts: any) => { calls.push(['enroll', name, opts]); return `saved ${name}` },
    composeScene: async (_c: string, ppl: string[], scene: string) => { calls.push(['scene', ppl, scene]); return 'created and sent' },
  })

  it('rosterLine lists names, aliases, relations, photo counts (no image data)', () => {
    const line = rosterLine([
      { id: 'rita', names: ['Tova', 'savta', 'סבתא'], relation: "Alex's mom", count: 3, heightCm: 158 },
      { id: 'zed', names: ['Zed'], count: 1 }, // no height
    ])
    expect(line).toContain('Tova')
    expect(line).toContain('savta')
    expect(line).toContain("Alex's mom")
    expect(line).toContain('3 photos')
    expect(line).toContain('158cm') // height surfaced so the model knows it's stored
    expect(line).toMatch(/Zed.*\[1 photo\]/) // no height → no cm suffix
    expect(rosterLine([])).toBe('') // empty roster → no section
  })

  it('enroll_person + create_scene are owner-only', () => {
    const mem = openMemory(root)
    const asStranger = buildTools(peopleDeps(mem, []), 'x', { isOwner: false }) as any
    expect(asStranger.enroll_person).toBeUndefined()
    expect(asStranger.create_scene).toBeUndefined()
    const asOwner = buildTools(peopleDeps(mem, []), 'x', { isOwner: true }) as any
    expect(asOwner.enroll_person).toBeDefined()
    expect(asOwner.create_scene).toBeDefined()
  })

  it('create_scene forwards resolved names + scene to composeScene', async () => {
    const mem = openMemory(root); const calls: any[] = []
    const tools = buildTools(peopleDeps(mem, calls), 'owner', { isOwner: true }) as any
    const out = await tools.create_scene.execute({ people: ['Itai', 'Tova'], scene: 'on the moon' }, { toolCallId: 't', messages: [] })
    expect(out).toBe('created and sent')
    expect(calls).toContainEqual(['scene', ['Itai', 'Tova'], 'on the moon'])
  })

  it("buildSystem injects the People roster ONLY for owners", () => {
    const mem = openMemory(root)
    const owner = buildSystem(peopleDeps(mem, []), 'x', new Date(2026, 5, 10), { name: 'Dan', isOwner: true })
    expect(owner).toContain('People you can place in AI scenes')
    expect(owner).toContain('Itai')
    const guest = buildSystem(peopleDeps(mem, []), 'x', new Date(2026, 5, 10), { name: 'Dana', isOwner: false })
    expect(guest).not.toContain('People you can place in AI scenes')
  })

  const SOUL = 'Top\n<!-- family -->\nKids: Eden & Omer\n<!-- /family -->\n<!-- guest -->\nGuest here.\n<!-- /guest -->\nShared tone.'

  it('soulFor keeps family text for family, guest text for guests, never the markers', () => {
    expect(soulFor(SOUL, false)).toBe('Top\nKids: Eden & Omer\nShared tone.')
    expect(soulFor(SOUL, true)).toBe('Top\nGuest here.\nShared tone.')
  })

  it("guest group: no family soul, no saved facts, no other group's memory, no roster — only its own memory", () => {
    const mem = openMemory(root)
    mem.addFact('owner', 'lives in Florentin')
    mem.addGroupFact('fam@g.us', 'Savta is 80')
    mem.addGroupFact('work@g.us', 'Trip to Boston in November')
    const sys = buildSystem({ ...peopleDeps(mem, []), soul: SOUL }, 'owner', new Date(2026, 5, 10), { name: 'Dan', inGroup: true, groupChatJid: 'work@g.us', isOwner: false, guest: true })
    expect(sys).toContain('Guest here.')
    expect(sys).toContain('Trip to Boston in November')
    for (const leak of ['Eden', 'Florentin', 'Savta', 'People you can place in AI scenes']) expect(sys).not.toContain(leak)
  })

  it('guest group: the owner gets no owner-only or memory tools', () => {
    const mem = openMemory(root)
    const tools = buildTools({ ...peopleDeps(mem, []), sendSavedPhoto: async () => 'ok' }, 'owner', { isOwner: false, inGroup: true, chatJid: 'work@g.us', chatScope: 'work@g.us', guest: true }) as any
    expect(tools.remember_group).toBeDefined() // this group's own memory
    for (const name of ['remember', 'read_self_chat', 'enroll_person', 'post_to_group', 'switch_model']) expect(tools[name]).toBeUndefined()
    expect(tools.searchHistory).toBeDefined() // scoped to this group, still useful
  })

  it('resend_photo searches only within the chat scope', async () => {
    const mem = openMemory(root); const seen: any[] = []
    const tools = buildTools({ ...deps(mem), sendSavedPhoto: async (c, q, scope) => { seen.push([c, q, scope]); return 'ok' } }, 'nadav', { inGroup: true, chatJid: 'work@g.us', chatScope: 'work@g.us' }) as any
    await tools.resend_photo.execute({ query: 'beach photo' }, { toolCallId: 't', messages: [] })
    expect(seen).toEqual([['work@g.us', 'beach photo', 'work@g.us']])
  })
})

describe('worker questions (fromSandbox) get no personal context', () => {
  it("skips the owner's facts/episodes, roster and ledger; keeps date and speaker", () => {
    const memory = { injectContext: () => 'OWNER FACTS AND EPISODES', loadGroupFacts: () => '' } as any
    const deps = { soul: 'SOUL', memory, listPeople: () => [{ id: 'p', names: ['Eden'], count: 1 }] as any, listGroupPeople: () => [], ledger: { kids: () => ['Eden'] } as any }
    const normal = buildSystem(deps, 'owner', new Date(), { name: 'Dan', isOwner: true })
    expect(normal).toContain('OWNER FACTS')
    const sandbox = buildSystem(deps, 'owner', new Date(), { name: 'Claude Code', isOwner: true, fromSandbox: true })
    expect(sandbox).toContain('SOUL')
    expect(sandbox).toContain('Claude Code')
    for (const leak of ['OWNER FACTS', 'Eden', 'Pocket money']) expect(sandbox).not.toContain(leak)
  })
})
