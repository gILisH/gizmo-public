import { describe, it, expect } from 'vitest'
import { createTurnHandler } from '../../src/transport/turn'
import type { InboundMessage } from '../../src/transport/types'
import type { MediaDeps } from '../../src/media'

// A controllable fake clock so tests drive the debounce deterministically.
function fakeClock() {
  let now = 0
  const timers: { at: number; fn: () => void; id: number }[] = []
  let seq = 0
  const schedule = (fn: () => void, ms: number) => {
    const id = ++seq
    timers.push({ at: now + ms, fn, id })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  const clearTimer = (t: ReturnType<typeof setTimeout>) => {
    const i = timers.findIndex((x) => x.id === (t as unknown as number))
    if (i >= 0) timers.splice(i, 1)
  }
  const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() } // flush chained microtasks
  const advance = async (ms: number) => {
    await drain() // let async work that will SCHEDULE timers (media processing) settle first
    now += ms
    const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)
    for (const t of due) {
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
    await drain() // let respond()/newly-scheduled work settle
  }
  return { schedule, clearTimer, advance, drain }
}

// Build a raw WAMessage-ish object the map helpers understand.
let idc = 0
const textMsg = (chat: string, sender: string, text: string) => ({
  key: { remoteJid: chat, id: `m${++idc}`, participant: chat.endsWith('@g.us') ? sender : '', fromMe: false },
  message: { conversation: text },
  messageTimestamp: 100,
  pushName: 'Tester',
})
const imageMsg = (chat: string, sender: string, caption?: string) => ({
  key: { remoteJid: chat, id: `m${++idc}`, participant: chat.endsWith('@g.us') ? sender : '', fromMe: false },
  message: { imageMessage: { caption, mimetype: 'image/jpeg' } },
  messageTimestamp: 100,
  pushName: 'Tester',
})

const noDeps: MediaDeps = { transcribe: async () => '', ocr: async () => '', pdfText: async () => '', docText: async () => '' }
const DM = '111@s.whatsapp.net'

function setup(opts: { download?: (m: any) => Promise<Buffer>; deps?: MediaDeps; debounceMs?: number } = {}) {
  const clock = fakeClock()
  const ingested: InboundMessage[] = []
  const replies: InboundMessage[] = []
  const handler = createTurnHandler({
    download: opts.download ?? (async () => Buffer.from('img')),
    ingest: async (m) => { ingested.push(m) },
    respond: async (m) => { replies.push(m) },
    deps: opts.deps ?? noDeps,
    debounceMs: opts.debounceMs ?? 1000,
    schedule: clock.schedule,
    clearTimer: clock.clearTimer,
  })
  const fire = (...msgs: any[]) => handler({ type: 'notify', messages: msgs })
  return { clock, ingested, replies, fire }
}

describe('createTurnHandler', () => {
  it('coalesces two rapid texts into ONE reply, joined', async () => {
    const { clock, ingested, replies, fire } = setup()
    fire(textMsg(DM, DM, 'how are you'))
    await clock.advance(300)
    fire(textMsg(DM, DM, 'and the weather?'))
    await clock.advance(1000)
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toBe('how are you\nand the weather?')
    expect(ingested).toHaveLength(2) // both stored individually
  })

  it('holds the turn until a slow photo is processed, then replies ONCE with photo + instruction', async () => {
    // vision/download takes longer than the debounce window → naive debounce would reply
    // to the text alone. The synchronous hold must keep the turn open.
    let release!: () => void
    const slow = new Promise<Buffer>((r) => { release = () => r(Buffer.from('img')) })
    const deps: MediaDeps = { ...noDeps, describeImage: async () => 'a plate of food' }
    const { clock, replies, fire } = setup({ download: () => slow, deps, debounceMs: 500 })
    fire(imageMsg(DM, DM))                       // photo (slow to download/describe)
    fire(textMsg(DM, DM, 'swap the food for thai')) // instruction, immediately after
    await clock.advance(500)                     // window elapses, but photo hold is active
    expect(replies).toHaveLength(0)              // MUST NOT reply yet
    release()                                     // photo download resolves → processed + re-arm
    await clock.advance(500)
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toContain('swap the food for thai')
    expect(replies[0].text).toContain('a plate of food')
  })

  it('shouldProcess false → no download or paid vision; the caption is still ingested', async () => {
    let downloads = 0
    const deps: MediaDeps = { ...noDeps, describeImage: async () => 'PAID', shouldProcess: () => false }
    const { clock, ingested, fire } = setup({ download: async () => { downloads++; return Buffer.from('img') }, deps })
    fire(imageMsg(DM, DM, 'look at this'), imageMsg(DM, DM))
    await clock.advance(1000)
    expect(downloads).toBe(0)
    expect(ingested.map((m) => m.text)).toEqual(['look at this'])
  })

  it('does not reply to fromMe echoes, but still ingests them', async () => {
    const { clock, ingested, replies, fire } = setup()
    const echo = textMsg(DM, DM, 'my own message')
    echo.key.fromMe = true
    fire(echo)
    await clock.advance(1000)
    expect(replies).toHaveLength(0)
    expect(ingested).toHaveLength(1)
  })

  it('keeps different senders in a group as separate turns', async () => {
    const G = '999@g.us'
    const { clock, replies, fire } = setup()
    fire(textMsg(G, 'a@lid', 'gizmo hi from A'))
    fire(textMsg(G, 'b@lid', 'gizmo hi from B'))
    await clock.advance(1000)
    expect(replies).toHaveLength(2)
    expect(replies.map((r) => r.senderJid).sort()).toEqual(['a@lid', 'b@lid'])
  })

  it('no respond handler (read-only) → ingests, never replies', async () => {
    const clock = fakeClock()
    const ingested: InboundMessage[] = []
    const handler = createTurnHandler({
      download: async () => Buffer.from('x'),
      ingest: async (m) => { ingested.push(m) },
      deps: noDeps,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
    })
    handler({ type: 'notify', messages: [textMsg(DM, DM, 'hello')] })
    await clock.advance(2000)
    expect(ingested).toHaveLength(1)
  })

  it('ignores append (offline replay on reconnect) — the double-echo fix', async () => {
    const clock = fakeClock()
    const seen: InboundMessage[] = []
    const handler = createTurnHandler({
      download: async () => Buffer.from('x'),
      ingest: async (m) => { seen.push(m) },
      respond: async (m) => { seen.push(m) },
      deps: noDeps,
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
    })
    handler({ type: 'append', messages: [textMsg(DM, DM, 'hi') as any] })
    await clock.advance(2000)
    expect(seen).toHaveLength(0)
  })

  it('read-only: a captioned photo is ingested ONCE, with caption AND description', async () => {
    // The personal socket used to run a text pass (caption only) AND a media pass under
    // the same id; the store kept the first row, so the description was lost.
    const clock = fakeClock()
    const ingested: InboundMessage[] = []
    const handler = createTurnHandler({
      download: async () => Buffer.from('x'),
      ingest: async (m) => { ingested.push(m) },
      deps: { ...noDeps, describeImage: async () => 'a red bicycle' },
      schedule: clock.schedule,
      clearTimer: clock.clearTimer,
    })
    handler({ type: 'notify', messages: [imageMsg(DM, DM, 'look at this')] })
    await clock.advance(2000)
    expect(ingested).toHaveLength(1)
    expect(ingested[0].text).toBe('look at this\n[image] a red bicycle')
  })
})
