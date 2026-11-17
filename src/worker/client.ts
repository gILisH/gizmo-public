import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { kindOf } from './files'
import type { Event, GizmoTool, Status } from './session'

// A request from Claude Code for Gizmo's own tools; references arrive as bytes.
export type GizmoRequest = { tool: GizmoTool; args: Record<string, unknown> & { references?: Buffer[] } }
export type Made = { text?: string; files?: Array<{ name: string; buf: Buffer }> }

// Gizmo's end of the line to its Claude Code session. send() passes Dan's message on;
// a loop polls the session's events for good and posts them — its replies, mid-work messages
// and files — to the chat he last talked to it from, and answers its questions with Gizmo's
// brain. The cursor and that chat live in a small file on /data, so a restart neither loses
// nor repeats anything.
export function makeClaudeCodeLine(o: {
  url: string
  statePath: string
  defaultChat: string // before he has ever talked to it: his DM
  sendText: (chatJid: string, text: string) => Promise<void>
  sendFile: (chatJid: string, file: Buffer, name: string, as: 'image' | 'video' | 'document', mimetype: string) => Promise<void>
  askGizmo: (chatJid: string, question: string) => Promise<string>
  fulfil: (chatJid: string, req: GizmoRequest) => Promise<Made> // Gizmo's image models / photo library
  record: (chatJid: string, text: string, key: string) => void // into the chat history, so Gizmo knows what it already sent
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}) {
  const f = o.fetch ?? fetch
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const post = (path: string, body: unknown) => f(`${o.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const state: { seq: number; chat?: string } = existsSync(o.statePath) ? JSON.parse(readFileSync(o.statePath, 'utf8')) : { seq: 0 }
  const save = () => {
    mkdirSync(dirname(o.statePath), { recursive: true })
    writeFileSync(o.statePath, JSON.stringify(state))
  }
  const chat = () => state.chat ?? o.defaultChat
  const ago = (at: number) => `${Math.max(0, Math.round((Date.now() - at) / 60_000))} min`

  const deliver = async (e: Event) => {
    const say = async (text: string) => {
      await o.sendText(chat(), text)
      o.record(chat(), text, String(e.seq))
    }
    if (e.kind === 'text') return say(`🛠️ ${e.text}`)
    if (e.kind === 'error') return say(`🛠️ משהו השתבש אצל Claude Code (${e.text})`)
    if (e.kind === 'file') {
      const res = await f(`${o.url}/file?path=${encodeURIComponent(e.path)}`)
      if (!res.ok) return
      const { as, mimetype } = kindOf(e.path)
      await o.sendFile(chat(), Buffer.from(await res.arrayBuffer()), basename(e.path), as, mimetype)
      o.record(chat(), [`[${as}] ${basename(e.path)}`, e.caption].filter(Boolean).join(' '), `${e.seq}f`)
      if (e.caption) await o.sendText(chat(), `🛠️ ${e.caption}`)
      return
    }
    // Questions and requests take a while (a brain turn, an image model): answered on the side
    // so its messages keep flowing meanwhile.
    if (e.kind === 'question') {
      void o.askGizmo(chat(), e.text)
        .catch((err) => `Gizmo couldn't answer (${(err as Error).message}); make a sensible choice.`)
        .then((a) => post('/answer', { id: e.id, text: a }))
        .catch(() => {})
      return
    }
    void (async () => {
      const refs = await Promise.all(((e.args.references as string[] | undefined) ?? []).map(async (p) => Buffer.from(await (await f(`${o.url}/file?path=${encodeURIComponent(p)}`)).arrayBuffer())))
      return o.fulfil(chat(), { tool: e.tool, args: { ...e.args, references: refs } })
    })()
      .catch((err): Made => ({ text: `Gizmo couldn't do it: ${(err as Error).message}` }))
      .then((m) => post('/fulfil', { id: e.id, text: m.text, files: (m.files ?? []).map((x) => ({ name: x.name, data: x.buf.toString('base64') })) }))
      .catch(() => {})
  }

  // One poll: deliver what's new, in order. A worker restart resets its numbering → start over.
  const tick = async () => {
    const { events, last } = (await (await f(`${o.url}/events?after=${state.seq}`)).json()) as { events: Event[]; last: number }
    if (last < state.seq) {
      state.seq = 0
      return save()
    }
    for (const e of events) {
      state.seq = e.seq
      save() // before delivering: a crash mid-send skips one message rather than repeating it forever
      await deliver(e).catch((err) => console.error('claude code delivery failed:', (err as Error).message))
    }
  }

  let running = false
  const run = async (pollMs = o.pollMs ?? 3_000) => {
    if (running) return
    running = true
    for (;;) {
      await tick().catch(() => {}) // worker down or restarting: try again next time
      await sleep(pollMs)
    }
  }

  // Dan → Claude Code. Its answer comes as events, straight to this chat.
  const send = async (chatJid: string, text: string, photos: Array<{ name: string; buf: Buffer }> = []): Promise<string> => {
    state.chat = chatJid
    save()
    const files = photos.map((p) => ({ name: p.name, data: p.buf.toString('base64') }))
    const res = await post('/messages', { text, files }).catch(() => null)
    if (!res?.ok) return "couldn't reach Claude Code (its server may be restarting); try again in a minute"
    const att = photos.length ? ` with ${photos.length} photo${photos.length > 1 ? 's' : ''}` : ''
    return `passed on${att}. Claude Code answers in this chat itself (its messages start with 🛠️), so don't answer for it or repeat it.`
  }

  const reset = async (): Promise<boolean> => Boolean((await post('/reset', {}).catch(() => null))?.ok)

  // What it's doing right now — facts from the session, not a guess.
  const status = async (): Promise<string> => {
    const st = (await f(`${o.url}/status`).then((r) => r.json()).catch(() => null)) as Status | null
    if (!st) return "couldn't reach Claude Code"
    if (!st.busy) return 'idle: not working on anything right now'
    const lines = [
      st.turnSince ? `thinking/working on a reply for ${ago(st.turnSince)}` : 'not mid-reply (free to talk)',
      st.tasks.length ? `running tasks:\n${st.tasks.map((t) => `- ${t.name ? `${t.name}: ` : '(no name) '}${t.description}`).join('\n')}` : '',
      st.question ? `waiting on your answer to: ${st.question}` : '',
      st.activity.length ? `latest steps (newest last):\n${st.activity.map((a) => `- ${ago(a.at)} ago: ${a.text}`).join('\n')}` : '',
    ]
    return lines.filter(Boolean).join('\n')
  }

  return { send, reset, status, run, tick }
}
export type ClaudeCodeLine = ReturnType<typeof makeClaudeCodeLine>
