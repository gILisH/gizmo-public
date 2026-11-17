import { describe, it, expect } from 'vitest'
import { openStore } from '../../src/store'
import type { StoredMessage } from '../../src/store/types'

const m = (over: Partial<StoredMessage> = {}): StoredMessage => ({
  id: 'M1', chatJid: 'c@s.whatsapp.net', senderJid: 's@s.whatsapp.net',
  senderName: 'Dana', text: 'hello', ts: 1700000000, fromMe: false, source: 'dedicated', ...over,
})

describe('store', () => {
  it('ingests and reads back a message', () => {
    const s = openStore(':memory:')
    expect(s.ingest(m())).toBe(true)
    expect(s.getMessage('M1')?.text).toBe('hello')
    expect(s.countMessages()).toBe(1)
    s.close()
  })

  it('is idempotent — re-ingesting the same id does not duplicate', () => {
    const s = openStore(':memory:')
    expect(s.ingest(m({ text: 'first' }))).toBe(true)
    expect(s.ingest(m({ text: 'second' }))).toBe(false)
    expect(s.countMessages()).toBe(1)
    expect(s.getMessage('M1')?.text).toBe('first')
    s.close()
  })

  it('recentMessages returns newest-first, honoring fromMe filter', () => {
    const s = openStore(':memory:')
    s.ingest(m({ id: 'old', text: 'oldest', ts: 100, fromMe: false }))
    s.ingest(m({ id: 'mid', text: 'mine', ts: 200, fromMe: true }))
    s.ingest(m({ id: 'new', text: 'newest', ts: 300, fromMe: false }))
    expect(s.recentMessages(2).map((x) => x.id)).toEqual(['new', 'mid']) // ts DESC
    expect(s.recentMessages(5, { fromMe: true }).map((x) => x.id)).toEqual(['mid'])
    expect(s.oldestMessages(2).map((x) => x.id)).toEqual(['old', 'mid']) // ts ASC — earliest first
    s.close()
  })

  it('chatScope restricts reads to the one asking chat', () => {
    const s = openStore(':memory:')
    s.ingest(m({ id: 'g', chatJid: 'grp@g.us', text: 'group msg', ts: 100 }))
    s.ingest(m({ id: 'p', chatJid: 'dan-private@lid', text: 'private', ts: 200 }))
    // no scope (feed owner) → sees both
    expect(s.recentMessages(5).map((x) => x.id).sort()).toEqual(['g', 'p'])
    // scoped to the group → only that group's messages, never the private DM
    expect(s.recentMessages(5, { chatScope: 'grp@g.us' }).map((x) => x.id)).toEqual(['g'])
    expect(s.oldestMessages(5, { chatScope: 'grp@g.us' }).map((x) => x.id)).toEqual(['g'])
    s.close()
  })

  it('PRIVACY INVARIANT: a chat-scoped read never leaks another chat via ANY read path', () => {
    const s = openStore(':memory:')
    // Dan's private 1:1 + another group + the shared group being asked in.
    s.ingest(m({ id: 'dm', chatJid: 'dan-dm@lid', text: 'private secret', ts: 100 }))
    s.ingest(m({ id: 'other', chatJid: 'other-grp@g.us', text: 'group alex not in', ts: 150 }))
    s.ingest(m({ id: 'shared', chatJid: 'shared-grp@g.us', text: 'shared', ts: 200 }))
    const scope = { chatScope: 'shared-grp@g.us' } // asking in the shared group
    const forbidden = (rows: { chatJid: string }[]) =>
      rows.some((r) => r.chatJid === 'dan-dm@lid' || r.chatJid === 'other-grp@g.us')
    expect(forbidden(s.recentMessages(50, scope))).toBe(false)
    expect(forbidden(s.oldestMessages(50, scope))).toBe(false)
    expect(forbidden(s.messagesInRange(0, 9999999999, 50, scope))).toBe(false)
    // and the shared group's own messages DO come back (scope, not blanket-deny)
    expect(s.recentMessages(50, scope).map((r) => r.id)).toEqual(['shared'])
    s.close()
  })

  it('removeChatMembers drops a member from a chat (leave/kick)', () => {
    const s = openStore(':memory:')
    s.setChatMembers('grp@g.us', ['+dan', '+alex'])
    s.removeChatMembers('grp@g.us', ['+alex'])
    expect(s.chatsForMember('+alex')).toEqual([]) // Alex left → no longer sees the group
    expect(s.chatMembers('grp@g.us')).toEqual(['+dan'])
    s.close()
  })

  it('resolves a missing sender name from contacts, else the phone from the JID', () => {
    const s = openStore(':memory:')
    // no sender_name, but a phone JID → falls back to the number
    s.ingest(m({ id: 'p', senderJid: '972500000000@s.whatsapp.net', senderName: undefined }))
    expect(s.getMessage('p')?.senderName).toBe('+972500000000')
    // once a contact is known, that wins
    s.upsertContact('972500000000@s.whatsapp.net', 'Dana Cohen')
    expect(s.getMessage('p')?.senderName).toBe('Dana Cohen')
    // an @lid with no contact stays unresolved (no phone to show)
    s.ingest(m({ id: 'l', senderJid: '123456@lid', senderName: undefined }))
    expect(s.getMessage('l')?.senderName).toBeUndefined()
    s.close()
  })

  it('messagesInRange returns messages within [from,to] chronologically', () => {
    const s = openStore(':memory:')
    s.ingest(m({ id: 'a', ts: 100, text: 'before' }))
    s.ingest(m({ id: 'b', ts: 250, text: 'inside' }))
    s.ingest(m({ id: 'c', ts: 400, text: 'after' }))
    expect(s.messagesInRange(200, 300, 10).map((x) => x.id)).toEqual(['b'])
    expect(s.messagesInRange(50, 500, 10).map((x) => x.id)).toEqual(['a', 'b', 'c']) // ts ASC
    s.close()
  })

  it('queues reminders, returns only due ones, and marks fired', () => {
    const s = openStore(':memory:')
    s.addReminder({ chatJid: 'c@x', ownerId: 'o', text: 'past', dueTs: 100 })
    s.addReminder({ chatJid: 'c@x', ownerId: 'o', text: 'future', dueTs: 9999999999 })
    const due = s.dueReminders(500)
    expect(due.map((r) => r.text)).toEqual(['past']) // only the past-due one
    s.markFired(due[0].id)
    expect(s.dueReminders(500)).toEqual([]) // fired → not returned again
    s.close()
  })

  it('stores scheduled tasks (instruction + recurrence) and reschedules instead of firing', () => {
    const s = openStore(':memory:')
    s.addReminder({ chatJid: 'c@x', ownerId: 'o', dueTs: 100, instruction: 'weather in Paris', recurrence: 'daily' })
    const [t] = s.dueReminders(500)
    expect(t.instruction).toBe('weather in Paris')
    expect(t.recurrence).toBe('daily')
    expect(t.text).toBe('') // task rows carry no fixed text
    s.rescheduleReminder(t.id, 90000) // recurring → bump due, stays live
    expect(s.dueReminders(500)).toEqual([]) // not due at 500 anymore
    expect(s.dueReminders(90000).map((r) => r.instruction)).toEqual(['weather in Paris']) // due again later
    s.close()
  })

  it('accumulates daily token usage', () => {
    const s = openStore(':memory:')
    expect(s.usageToday()).toBe(0)
    s.addUsage(1500)
    s.addUsage(500)
    expect(s.usageToday()).toBe(2000) // same day accumulates
    s.close()
  })

  it('paginates a chat by offset (deterministic, chronological)', () => {
    const s = openStore(':memory:')
    for (let i = 0; i < 30; i++) s.ingest(m({ id: `n${i}`, chatJid: 'c@x', text: `msg${i}`, ts: 1000 + i }))
    // newest 10 = msg29..msg20; skip 10 → next 10 = msg19..msg10, returned chronologically
    const page = s.messagesByChatPaged('c@x', 10, 10).map((x) => x.text)
    expect(page[0]).toBe('msg10')
    expect(page[page.length - 1]).toBe('msg19')
    s.close()
  })

  it('stores and resolves contact names', () => {
    const s = openStore(':memory:')
    s.upsertContact('s@s.whatsapp.net', 'Dana')
    expect(s.getContactName('s@s.whatsapp.net')).toBe('Dana')
    s.upsertContact('s@s.whatsapp.net', 'Dana Cohen')
    expect(s.getContactName('s@s.whatsapp.net')).toBe('Dana Cohen')
    s.close()
  })
})

describe('purge-statuses', () => {
  it('deletes status/channel rows with their FTS, trigram and vector entries and saved photos, nothing else', async () => {
    const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { purgeStatuses } = await import('../../src/purge')
    const s = openStore(':memory:', { embedDim: 2 })
    const row = (id: string, chatJid: string) => ({ id, chatJid, senderJid: 'x@s.whatsapp.net', text: `hello ${id}`, ts: 1, fromMe: false, source: 'personal' as const })
    for (const [id, chat] of [['personal:S1', 'status@broadcast'], ['personal:N1', '1203@newsletter'], ['personal:K1', 'k@s.whatsapp.net']]) {
      s.ingest(row(id, chat))
      s.indexMessage(id, `hello ${id}`, [1, 0])
    }
    const media = mkdtempSync(join(tmpdir(), 'gizmo-media-'))
    writeFileSync(join(media, 'S1.jpg'), 'x')
    writeFileSync(join(media, 'K1.jpg'), 'x')
    expect(purgeStatuses(s, media)).toEqual({ rows: 2, files: 1 })
    expect(s.countMessages()).toBe(1)
    expect(s.ftsSearch('hello', 10).map((r) => r.id)).toEqual(['personal:K1'])
    expect(s.trigramSearch('hello', 10).map((r) => r.id)).toEqual(['personal:K1'])
    expect(s.vecSearch([1, 0], 10).map((r) => r.id)).toEqual(['personal:K1'])
    expect(existsSync(join(media, 'S1.jpg'))).toBe(false)
    expect(existsSync(join(media, 'K1.jpg'))).toBe(true)
  })
})

describe('per-chat usage', () => {
  it('counts globally always and per chat only when given one', () => {
    const s = openStore(':memory:')
    s.addUsage(100)
    s.addUsage(50, 'guest@g.us')
    expect(s.usageToday()).toBe(150)
    expect(s.usageToday('guest@g.us')).toBe(50)
    expect(s.usageToday('other@g.us')).toBe(0)
  })
})
