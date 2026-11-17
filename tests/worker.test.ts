import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeCodeLine } from '../src/worker/client'
import { kindOf } from '../src/worker/files'
import { selfTools } from '../src/brain/tools/self'
import { confirmTools } from '../src/brain/tools/confirm'
import { makePostStager } from '../src/groups'
import { findPhotos, MAX_PHOTOS } from '../src/worker/photos'
import { makeSandboxControl } from '../src/worker/control'
import { makeSession, describeStep, QUIET } from '../src/worker/session'
import { makeFulfil, makePeopleGrants, GRANT_TTL_MS } from '../src/worker/fulfil'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }

describe('Claude Code session (worker side)', () => {
  it('messages queue into one stream, in order; a retired stream hands the rest to the next', async () => {
    const s = makeSession()
    s.push('hi')
    s.push('make a video')
    const a = s.stream()
    expect((await a.next()).value).toBe('hi')
    expect((await a.next()).value).toBe('make a video')
    const waiting = a.next()
    s.push('also add Tokyo')
    expect((await waiting).value).toBe('also add Tokyo')
    const pending = a.next()
    s.endStream()
    const b = s.stream().next() // the new stream starts waiting before the old one has woken
    expect((await pending).done).toBe(true)
    s.push('after reset')
    expect((await b).value).toBe('after reset')
  })
  it('replies become numbered events; the quiet marker and empty replies are dropped', () => {
    const s = makeSession()
    s.reply('done!')
    s.reply(QUIET)
    s.reply('  ')
    s.emit({ kind: 'file', path: '/work/v/out.mp4' })
    expect(s.since(0)).toEqual({ events: [{ seq: 1, kind: 'text', text: 'done!' }, { seq: 2, kind: 'file', path: '/work/v/out.mp4' }], last: 2 })
    expect(s.since(2).events).toEqual([])
  })
  it("its question waits for Gizmo's answer, or falls back after the timeout", async () => {
    const s = makeSession()
    const q = s.ask('Is Eden the one with glasses?', 1000)
    const ev = s.since(0).events[0] as { id: number }
    expect(s.status().question).toBe('Is Eden the one with glasses?')
    expect(s.answer(ev.id + 1, 'wrong id')).toBe(false)
    expect(s.answer(ev.id, 'No, Omer wears glasses')).toBe(true)
    expect(await q).toBe('No, Omer wears glasses')
    expect(s.status().question).toBeNull()
    expect(await s.ask('anyone?', 5)).toMatch(/didn't answer in time/)
  })
  it("a request for Gizmo's tools waits for what Gizmo hands back", async () => {
    const s = makeSession()
    const r = s.request('generate_image', { prompt: 'anime Eden' }, 1000)
    const ev = s.since(0).events[0] as { id: number; kind: string; tool: string }
    expect(ev).toMatchObject({ kind: 'request', tool: 'generate_image' })
    expect(s.fulfil(ev.id + 1, {})).toBe(false)
    expect(s.fulfil(ev.id, { files: [{ name: 'image.png', data: 'eA==' }] })).toBe(true)
    expect(await r).toEqual({ files: [{ name: 'image.png', data: 'eA==' }] })
    expect(await s.request('get_photos', { queries: [] }, 5)).toEqual({ text: "Gizmo didn't deliver in time." })
  })
  it("a task carries its agent's name, whichever of the list and task_started comes first", () => {
    const s = makeSession()
    s.agentNamed('tu1', 'tokyo-video')
    s.agentNamed('tu2', 'budget-sheet')
    s.setTasks([{ id: 't1', description: 'Render Tokyo video' }]) // the list can land before task_started
    expect(s.status().tasks).toEqual([{ id: 't1', description: 'Render Tokyo video' }])
    s.taskStarted('t1', 'tu1')
    s.taskStarted('t2', 'tu2')
    s.taskStarted('t3', 'unknown') // an unnamed agent or a shell stays nameless
    s.setTasks([{ id: 't1', description: 'Render Tokyo video' }, { id: 't2', description: 'Budget' }, { id: 't3', description: 'npm i' }])
    expect(s.status().tasks.map((t) => t.name)).toEqual(['tokyo-video', 'budget-sheet', undefined])
  })
  it('busy while mid-reply or while background jobs run', () => {
    let t = 1000
    const s = makeSession(() => t)
    expect(s.status().busy).toBe(false)
    s.push('hi')
    expect(s.status()).toMatchObject({ busy: true, turnSince: 1000 })
    s.stream().next() // the SDK takes it
    s.turnEnded()
    expect(s.status().busy).toBe(false)
    s.setTasks([{ id: 't1', description: 'render the Tokyo video' }])
    expect(s.status()).toMatchObject({ busy: true, turnSince: null })
    t = 2000
    s.working() // a background job finished and woke it
    expect(s.status().turnSince).toBe(2000)
  })
  it('keeps the latest steps, and describes tool calls in one line', () => {
    const s = makeSession()
    for (let i = 0; i < 20; i++) s.note(`step ${i}`)
    expect(s.status().activity.map((a) => a.text)).toEqual(['step 12', 'step 13', 'step 14', 'step 15', 'step 16', 'step 17', 'step 18', 'step 19'])
    expect(describeStep({ type: 'tool_use', name: 'Bash', input: { command: 'npx remotion render\n--x' } })).toBe('$ npx remotion render')
    expect(describeStep({ type: 'tool_use', name: 'Agent', input: { description: 'render the video' } })).toBe('started a background agent: render the video')
    expect(describeStep({ type: 'tool_use', name: 'mcp__gizmo__send_message', input: { text: 'half done' } })).toBe('send_message half done')
    expect(describeStep({ type: 'thinking' })).toBeNull()
  })
})

describe('Claude Code line (Gizmo side)', () => {
  function line(o: { events?: unknown[]; last?: number; status?: unknown; statePath?: string } = {}) {
    const texts: Array<[string, string]> = []
    const files: Array<[string, string, string]> = []
    const recorded: Array<[string, string, string]> = []
    const posts: Array<[string, any]> = []
    const statePath = o.statePath ?? join(mkdtempSync(join(tmpdir(), 'cc-')), 'claude-code.json')
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = url.replace('http://worker', '')
      if (init?.method === 'POST') { posts.push([path, JSON.parse(String(init.body))]); return json(path === '/messages' ? 202 : 200, {}) }
      if (path.startsWith('/events')) {
        const after = Number(new URL(url).searchParams.get('after'))
        const evs = (o.events ?? []) as Array<{ seq: number }>
        return json(200, { events: evs.filter((e) => e.seq > after), last: o.last ?? evs.at(-1)?.seq ?? 0 })
      }
      if (path.startsWith('/file')) return new Response(`bytes of ${new URL(url).searchParams.get('path')}`)
      return json(200, o.status)
    }) as typeof globalThis.fetch
    const l = makeClaudeCodeLine({
      url: 'http://worker', statePath, defaultChat: 'dan-dm',
      sendText: async (c, t) => { texts.push([c, t]) },
      sendFile: async (c, buf, name, as) => { files.push([c, `${name}:${as}`, buf.toString()]) },
      askGizmo: async (_c, q) => `Gizmo says: ${q}`,
      record: (c, t, key) => { recorded.push([c, t, key]) },
      fulfil: async (c, req) => ({ text: `made for ${c}: ${req.tool} with ${(req.args.references ?? []).map((b) => b.toString()).join('+')}`, files: [{ name: 'image.png', buf: Buffer.from('png') }] }),
      fetch, sleep: async () => {},
    })
    return { l, texts, files, posts, statePath, recorded }
  }
  it('passes his message (and photos) on, and its messages go to the chat he wrote from', async () => {
    const { l, texts, files, posts, recorded } = line({ events: [
      { seq: 1, kind: 'text', text: 'on it' },
      { seq: 2, kind: 'file', path: '/work/tokyo/tokyo.mp4', caption: 'here it is' },
      { seq: 3, kind: 'question', id: 7, text: "Alex's favourite colour?" },
      { seq: 4, kind: 'error', text: 'error_during_execution' },
    ] })
    expect(await l.send('family-group', 'make a Tokyo video', [{ name: 'a.jpg', buf: Buffer.from('img') }])).toMatch(/^passed on with 1 photo/)
    expect(posts[0]).toEqual(['/messages', { text: 'make a Tokyo video', files: [{ name: 'a.jpg', data: Buffer.from('img').toString('base64') }] }])
    await l.tick()
    await flush()
    expect(texts).toEqual([['family-group', '🛠️ on it'], ['family-group', '🛠️ here it is'], ['family-group', '🛠️ משהו השתבש אצל Claude Code (error_during_execution)']])
    expect(files).toEqual([['family-group', 'tokyo.mp4:video', 'bytes of /work/tokyo/tokyo.mp4']])
    // everything it sent is in the chat history, so Gizmo knows the video arrived
    expect(recorded).toEqual([
      ['family-group', '🛠️ on it', '1'],
      ['family-group', '[video] tokyo.mp4 here it is', '2f'],
      ['family-group', '🛠️ משהו השתבש אצל Claude Code (error_during_execution)', '4'],
    ])
    expect(posts[1]).toEqual(['/answer', { id: 7, text: "Gizmo says: Alex's favourite colour?" }])
  })
  it("fulfils its requests with Gizmo's tools, passing its reference files as bytes", async () => {
    const { l, posts } = line({ events: [{ seq: 1, kind: 'request', id: 3, tool: 'generate_image', args: { prompt: 'anime', references: ['/work/sheet.png'] } }] })
    await l.tick()
    await flush()
    expect(posts).toEqual([['/fulfil', { id: 3, text: 'made for dan-dm: generate_image with bytes of /work/sheet.png', files: [{ name: 'image.png', data: Buffer.from('png').toString('base64') }] }]])
  })
  it('never repeats a message, across restarts too; before he ever wrote, it goes to his DM', async () => {
    const events = [{ seq: 1, kind: 'text', text: 'hello' }]
    const a = line({ events })
    await a.l.tick()
    await a.l.tick()
    expect(a.texts).toEqual([['dan-dm', '🛠️ hello']])
    const b = line({ events, statePath: a.statePath }) // Gizmo restarted
    await b.l.tick()
    expect(b.texts).toEqual([])
  })
  it('a restarted worker numbers from 1 again: start over', async () => {
    const a = line({ events: [{ seq: 5, kind: 'text', text: 'old' }] })
    await a.l.tick()
    const b = line({ events: [{ seq: 1, kind: 'text', text: 'new' }], statePath: a.statePath })
    await b.l.tick() // sees last(1) < seq(5) → resets
    await b.l.tick()
    expect(b.texts).toEqual([['dan-dm', '🛠️ new']])
  })
  it('status is facts from the session', async () => {
    expect(await line({ status: { busy: false, turnSince: null, activity: [], tasks: [], question: null } }).l.status()).toMatch(/^idle/)
    const busy = { busy: true, turnSince: null, activity: [{ at: Date.now() - 60_000, text: '$ npx remotion render' }], tasks: [{ id: 't', description: 'render the Tokyo video' }], question: null }
    expect(await line({ status: busy }).l.status()).toBe('not mid-reply (free to talk)\nrunning tasks:\n- (no name) render the Tokyo video\nlatest steps (newest last):\n- 1 min ago: $ npx remotion render')
  })
  it('videos and photos play inline; the rest are documents', () => {
    expect(kindOf('a.MP4')).toEqual({ as: 'video', mimetype: 'video/mp4' })
    expect(kindOf('a.jpeg').as).toBe('image')
    expect(kindOf('a.pdf')).toEqual({ as: 'document', mimetype: 'application/pdf' })
    expect(kindOf('a.weird')).toEqual({ as: 'document', mimetype: 'application/octet-stream' })
  })
})

describe('claude_code gating', () => {
  const deps = { claudeCode: { owner: '972500000000', send: async () => 'passed on', status: async () => 'idle' }, actions: makePostStager() } as any
  it('Dan gets it in his DM and in family groups', () => {
    expect(Object.keys(selfTools(deps, '972500000000', { chatJid: 'dm' }))).toEqual(['claude_code', 'claude_code_status'])
    expect(Object.keys(selfTools(deps, '972500000000', { inGroup: true }))).toEqual(['claude_code', 'claude_code_status'])
  })
  // Dan's claude_code tool over a stager, recording what reaches Claude Code.
  const stagedLine = (ctx: Record<string, unknown> = {}) => {
    const sent: unknown[][] = []
    const actions = makePostStager()
    const cc = { owner: '972500000000', send: async (...a: unknown[]) => { sent.push(a); return 'passed on' } }
    const t: any = selfTools({ claudeCode: cc, actions } as any, '972500000000', { chatJid: 'dm', turnId: 't1', ...ctx })
    const stage = (args: Record<string, unknown>) => t.claude_code.execute(args, { toolCallId: 't', messages: [] })
    return { sent, actions, stage }
  }
  it('stages the message; only a confirm in a LATER turn passes the chat, his words, photos and fresh through', async () => {
    const { sent, actions, stage } = stagedLine({ chatScope: 'dm' })
    expect(await stage({ message: 'תכין סרטון', photos: ['Eden'], fresh: true })).toMatch(/^STAGED/)
    expect(sent).toEqual([]) // nothing reached Claude Code yet
    const sameTurn: any = confirmTools({ actions } as any, '972500000000', { isOwner: true, chatJid: 'dm', turnId: 't1' })
    expect(await sameTurn.confirm_action.execute({}, { toolCallId: 't', messages: [] })).toMatch(/^not done/)
    expect(await actions.confirm('dm', '')).toMatch(/^not done/) // a scheduled replay has no turn id
    const next: any = confirmTools({ actions } as any, '972500000000', { isOwner: true, chatJid: 'dm', turnId: 't2' })
    expect(await next.confirm_action.execute({}, { toolCallId: 't', messages: [] })).toBe('passed on')
    expect(sent).toEqual([['dm', 'תכין סרטון', { photos: ['Eden'], chatScope: 'dm', fresh: true }]])
  })
  it('a message about one running task goes in tagged with its name', async () => {
    const { sent, actions, stage } = stagedLine()
    expect(await stage({ message: 'make the music calmer', task: ' tokyo-video ' })).toContain('[re: tokyo-video] make the music calmer')
    await actions.confirm('dm', 't2')
    expect(sent[0][1]).toBe('[re: tokyo-video] make the music calmer')
  })
  it('anyone else, a guest group, or no worker: absent', () => {
    expect(selfTools(deps, '972511111111', {})).toEqual({})
    expect(selfTools(deps, '972500000000', { inGroup: true, guest: true })).toEqual({})
    expect(selfTools({} as any, '972500000000', {})).toEqual({})
    expect(selfTools({ claudeCode: deps.claudeCode } as any, '972500000000', {})).toEqual({}) // no stager → fail closed
  })
})

describe('findPhotos', () => {
  const img = (s: string) => Buffer.from(s)
  const d = {
    personPhotos: (n: string) => (['eden', 'עדן'].includes(n.toLowerCase()) ? { name: 'Eden', photos: [img('e1'), img('e2')] } : undefined),
    searchPhotos: async (q: string, limit: number) =>
      q === 'beach' ? Array.from({ length: limit }, (_, i) => ({ id: `m${i}`, buf: img(`b${i}`) })) : [],
  }
  it('a name gets face photos, a description gets history photos, misses are reported', async () => {
    const { photos, missed } = await findPhotos(['עדן', 'beach', 'nothing here'], d)
    expect(photos.map((p) => p.name)).toEqual(['eden-1.jpg', 'eden-2.jpg', 'beach-1.jpg', 'beach-2.jpg', 'beach-3.jpg', 'beach-4.jpg', 'beach-5.jpg', 'beach-6.jpg'])
    expect(photos[0]!.buf.toString()).toBe('e1')
    expect(missed).toEqual(['nothing here'])
  })
  it('the same photo twice is sent once, and the total is capped', async () => {
    expect((await findPhotos(['Eden', 'eden'], d)).photos).toHaveLength(2)
    expect((await findPhotos(Array(10).fill('beach').map((q, i) => (i % 2 ? q : 'beach')), { ...d, searchPhotos: async (_q, l) => Array.from({ length: l }, () => ({ id: String(Math.random()), buf: img('x') })) })).photos).toHaveLength(MAX_PHOTOS)
  })
})

describe('sandbox control (the off switch)', () => {
  const ctl = () => {
    const flagPath = join(mkdtempSync(join(tmpdir(), 'ctl-')), 'sandboxes-paused')
    const fetch = (async (url: string) => {
      if (url.startsWith('http://down')) throw new Error('ECONNREFUSED')
      return json(200, { stopped: url.startsWith('http://worker') ? 'birthday video' : null })
    }) as typeof globalThis.fetch
    return makeSandboxControl({ urls: { worker: 'http://worker', coder: 'http://coder', other: 'http://down' }, flagPath, fetch })
  }
  it('stop aborts what is running and skips idle or unreachable sandboxes', async () => {
    expect(await ctl().stop()).toEqual(['worker: birthday video'])
  })
  it('pause is a flag that resume clears', () => {
    const c = ctl()
    expect(c.paused()).toBe(false)
    c.pause()
    expect(c.paused()).toBe(true)
    c.resume()
    expect(c.paused()).toBe(false)
  })
})

describe('stop_tasks', () => {
  const sb = () => {
    let paused = false
    return { owner: '972500000000', stop: async () => ['worker: birthday video'], pause: () => { paused = true }, resume: () => { paused = false }, paused: () => paused }
  }
  const run = (t: any, action: string) => t.stop_tasks.execute({ action }, { toolCallId: 't', messages: [] })
  it('stop, pause and resume', async () => {
    const s = sb()
    const t: any = selfTools({ sandboxes: s } as any, '972500000000', { inGroup: true })
    expect(await run(t, 'stop')).toBe('stopped worker: birthday video')
    expect(s.paused()).toBe(false)
    expect(await run(t, 'pause')).toContain('Paused')
    expect(s.paused()).toBe(true)
    expect(await run(t, 'resume')).toMatch(/^resumed/)
    expect(s.paused()).toBe(false)
  })
  it('only Dan, never in a guest group', () => {
    expect(selfTools({ sandboxes: sb() } as any, '972511111111', {})).toEqual({})
    expect(selfTools({ sandboxes: sb() } as any, '972500000000', { guest: true })).toEqual({})
  })
})

describe("Gizmo's tools for Claude Code (fulfil)", () => {
  const png = (s: string) => Buffer.from(s)
  function setup(o: { editors?: string[] } = {}) {
    const calls: string[] = []
    const editor = (name: string) => async (imgs: Buffer[], p: string) => { calls.push(`${name}(${imgs.map((b) => b.toString()).join(',')}): ${p}`); return png(name) }
    const editors = Object.fromEntries((o.editors ?? ['gemini', 'flux', 'grok']).map((n) => [n, editor(n)]))
    const fulfil = makeFulfil({
      personPhotos: (n) => (n === 'Eden' ? { name: 'Eden', photos: [png('e1'), png('e2'), png('e3')] } : undefined),
      searchPhotos: (chat) => async (q) => (q === 'beach' ? [{ id: 'm1', buf: png(`beach in ${chat}`) }] : []),
      editors: editors as any,
      defaultEditor: () => 'gemini',
      generate: async (p) => { calls.push(`generate: ${p}`); return png('gen') },
    })
    return { fulfil, calls }
  }
  const img = (args: object) => ({ tool: 'generate_image' as const, args: args as any })
  it('people by name bring their saved faces (two each) as references', async () => {
    const { fulfil, calls } = setup()
    const r = await fulfil('dm', img({ prompt: 'anime Eden in space', people: ['Eden', 'Zed'] }))
    expect(calls).toEqual(['gemini(e1,e2): anime Eden in space'])
    expect(r.files![0]!.buf.toString()).toBe('gemini')
    expect(r.text).toBe('Made with gemini from 2 references. No saved face photos for: Zed.')
  })
  it('several references need an editor that can fuse them; one may use any', async () => {
    const { fulfil, calls } = setup({ editors: ['grok', 'flux'] })
    await fulfil('dm', img({ prompt: 'p', engine: 'grok', references: [png('a'), png('b')] }))
    await fulfil('dm', img({ prompt: 'q', engine: 'grok', references: [png('a')] }))
    expect(calls).toEqual(['flux(a,b): p', 'grok(a): q'])
  })
  it('no references: text to image (flux), or gemini when asked for', async () => {
    const { fulfil, calls } = setup()
    await fulfil('dm', img({ prompt: 'a nebula' }))
    await fulfil('dm', img({ prompt: 'a moon', engine: 'gemini' }))
    expect(calls).toEqual(['generate: a nebula', 'gemini(): a moon'])
  })
  it("get_photos uses the chat's access to history photos", async () => {
    const { fulfil } = setup()
    const r = await fulfil('family-group', { tool: 'get_photos', args: { queries: ['Eden', 'beach', 'nothing'] } })
    expect(r.files!.map((f) => f.name)).toEqual(['eden-1.jpg', 'eden-2.jpg', 'eden-3.jpg', 'beach-1.jpg'])
    expect(r.files![3]!.buf.toString()).toBe('beach in family-group')
    expect(r.text).toBe('No photos found for: nothing')
  })
})

describe('worker face access (G3): only people Dan named', () => {
  const png = (s: string) => Buffer.from(s)
  const roster = [{ id: 'p1', names: ['Eden', 'עדן'] }, { id: 'p2', names: ['Lia'] }]
  const resolve = (n: string) => roster.find((p) => p.names.some((x) => x.toLowerCase() === n.toLowerCase()))
  const setup = () => {
    let t = 0
    const grants = makePeopleGrants({ list: () => roster, resolve, now: () => t })
    const fulfil = makeFulfil({
      mayUse: grants.allowed,
      personPhotos: (n) => { const p = resolve(n); return p ? { name: p.names[0], photos: [png(`${p.id}-1`)] } : undefined },
      searchPhotos: () => async (q) => (q === 'beach' ? [{ id: 'm1', buf: png('beach') }] : []),
      editors: { gemini: async () => png('edited') } as any,
      defaultEditor: () => 'gemini',
      generate: async () => png('gen'),
    })
    return { grants, fulfil, tick: (ms: number) => { t += ms } }
  }

  it('refuses a person nobody named, with a message the worker can relay', async () => {
    const { fulfil } = setup()
    const r = await fulfil('dm', { tool: 'get_photos', args: { queries: ['Lia', 'beach'] } as any })
    expect(r.files?.map((f) => f.buf.toString())).toEqual(['beach']) // descriptions still work
    expect(r.text).toMatch(/Not allowed: Lia — Dan didn't name them/)
    const g = await fulfil('dm', { tool: 'generate_image', args: { prompt: 'x', people: ['Lia'] } as any })
    expect(g.files).toBeUndefined()
    expect(g.text).toMatch(/Not allowed: Lia/)
  })

  it('a name in his message (any alias) grants that person for a day; fresh clears', async () => {
    const { grants, fulfil, tick } = setup()
    grants.grant(['תכין סרטון של עדן בחלל', 'beach'])
    expect((await fulfil('dm', { tool: 'get_photos', args: { queries: ['Eden'] } as any })).files?.map((f) => f.buf.toString())).toEqual(['p1-1'])
    expect(grants.allowed('Lia')).toBe(false)
    tick(GRANT_TTL_MS + 1)
    expect(grants.allowed('Eden')).toBe(false)
    grants.grant(['Eden again'])
    grants.clear()
    expect(grants.allowed('Eden')).toBe(false)
  })
})
