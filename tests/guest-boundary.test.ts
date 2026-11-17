import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildTools } from '../src/brain'
import { makePostStager } from '../src/groups'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openFileStore } from '../src/files'

// Red-team contract for guest groups: a fake corpus answers in-scope reads with this
// group's data and EVERY other read with a canary. Every guest tool is called with
// schema-generated input; no output and no side-effect may carry the canary or another chat.
const GUEST = 'work@g.us'
const CANARY = 'PRIVATE-CANARY'
const row = (chat: string) => ({ id: 'm', chatJid: chat, senderJid: 's', senderName: 'S', text: chat === GUEST ? 'work stuff' : CANARY, ts: 1, fromMe: false, source: 'personal' as const })
const scoped = (scope?: string) => [row(scope === GUEST ? GUEST : 'private@s.whatsapp.net')]

function fakeDeps(calls: unknown[][]) {
  // A DM's file carrying the canary, under the same name the schema sampler asks for ('x').
  const files = openFileStore(mkdtempSync(join(tmpdir(), 'gizmo-files-')))
  files.save('private@s.whatsapp.net', { name: 'x', format: 'txt', text: CANARY })
  const explicit: Record<string, (...a: any[]) => unknown> = {
    search: async (_q: string, o?: { chatScope?: string }) => scoped(o?.chatScope),
    recent: (_l: number, o?: { chatScope?: string }) => scoped(o?.chatScope),
    oldest: (_l: number, o?: { chatScope?: string }) => scoped(o?.chatScope),
    range: (_a: number, _b: number, _l: number, o?: { chatScope?: string }) => scoped(o?.chatScope),
    pageChat: (chat: string) => scoped(chat),
    sendSavedPhoto: async (_c: string, _q: string, scope?: string) => (scope === GUEST ? 'sent' : CANARY),
    resolvePhoto: async (_q: string, _c?: string, scope?: string) => (scope === GUEST ? Buffer.from('x') : Buffer.from(CANARY)),
    listPeople: () => [{ id: 'p', names: [CANARY], count: 1 }],
  }
  // Any other dep is present (so its tool is exposed) and records what it was given.
  return new Proxy({}, {
    get: (_t, key: string) => key === 'files' ? files : (...args: unknown[]) => {
      calls.push([key, ...args])
      return explicit[key] ? explicit[key](...args) : Promise.resolve('ok')
    },
  }) as any
}

// Minimal valid input from a tool's zod schema (via JSON Schema).
function sample(s: any): unknown {
  if (s.enum) return s.enum[0]
  if (s.anyOf) return sample(s.anyOf[0])
  switch (s.type) {
    case 'object': return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v)]))
    case 'array': return [sample(s.items ?? { type: 'string' })]
    case 'number': case 'integer': return s.minimum ?? 1
    case 'boolean': return false
    default: return 'x'
  }
}

const guestTools = (calls: unknown[][]) =>
  buildTools(fakeDeps(calls), 'owner', { isOwner: false, inGroup: true, chatJid: GUEST, chatScope: GUEST, guest: true }) as Record<string, any>

describe('guest group boundary', () => {
  it('exposes exactly the reviewed tool set — a new tool fails here until reviewed for guests', () => {
    expect(Object.keys(guestTools([])).sort()).toEqual([
      'cancel_reminder', 'create_scene', 'delete_file', 'delete_message', 'edit_image', 'edit_keep_face', 'edit_message', 'fetch_earlier_messages',
      'generate_image', 'list_files', 'list_reminders', 'messagesByDate', 'oldest_messages', 'place_into_photo', 'react', 'read_file', 'recentMessages', 'remember_group',
      'reply_as_voice', 'reply_quote', 'resend_photo', 'revise_family_memory', 'save_file', 'searchHistory', 'send_contact', 'send_file', 'send_from_url', 'send_gif', 'send_location',
      'send_meme', 'send_poll', 'set_reminder', 'set_timezone', 'web_fetch', 'web_search',
    ])
  })

  it('no tool returns or sends another chat\'s data', async () => {
    const calls: unknown[][] = []
    const tools = guestTools(calls)
    for (const [name, t] of Object.entries(tools)) {
      const input = sample(z.toJSONSchema(t.inputSchema))
      const out = await Promise.resolve(t.execute(input, { toolCallId: name, messages: [] })).catch((e: Error) => e.message)
      expect(JSON.stringify(out ?? ''), name).not.toContain(CANARY)
    }
    const jids = JSON.stringify(calls).match(/[\w.-]+@(g\.us|s\.whatsapp\.net|lid)/g) ?? []
    expect(new Set(jids)).toEqual(new Set([GUEST])) // every side-effect targets this group only
    expect(JSON.stringify(calls)).not.toContain(CANARY)
  })
})

// The Claude Code worker is internet-facing and injectable; its questions to Gizmo run with
// the owner's identity in his DM, so the tool set is pinned here: read-only history only.
describe('worker questions (fromSandbox)', () => {
  it('get only the read-only history tools — no Google, sends, sandboxes, scheduling, ledger or deletes', () => {
    const extra: unknown[] = []
    const deps = fakeDeps([])
    const stubs: Record<string, unknown> = {
      extraTools: (ctx: { fromSandbox: boolean }) => { extra.push(ctx); return ctx.fromSandbox ? {} : { gmail_search: {} } },
      ledger: { kids: () => ['Eden'] },
      claudeCode: { owner: 'owner', send: async () => 'ok', status: async () => 'idle' },
      sandboxes: { owner: 'owner', stop: async () => [], pause: () => {}, resume: () => {}, paused: () => false },
      proposeChange: { owner: 'owner', start: async () => 'ok' },
      actions: makePostStager(),
    }
    const withGoogle = new Proxy(deps, { get: (t, k: string) => (k in stubs ? stubs[k] : t[k]) })
    const tools = buildTools(withGoogle, 'owner', { isOwner: true, inGroup: false, chatJid: 'owner@s.whatsapp.net', chatScope: 'owner@s.whatsapp.net', fromSandbox: true })
    expect(Object.keys(tools).sort()).toEqual(['fetch_earlier_messages', 'messagesByDate', 'oldest_messages', 'recentMessages', 'searchHistory'])
    expect(extra).toEqual([expect.objectContaining({ fromSandbox: true })])
    // Same speaker, same chat, not from the sandbox: the owner's full set (sanity that the gate is what removes them).
    const owner = buildTools(withGoogle, 'owner', { isOwner: true, inGroup: false, chatJid: 'owner@s.whatsapp.net' })
    expect(Object.keys(owner)).toEqual(expect.arrayContaining(['post_to_group', 'confirm_send', 'claude_code', 'propose_change', 'stop_tasks', 'schedule_task', 'confirm_action', 'ledger_add', 'forget_person', 'gmail_search']))
  })
})
