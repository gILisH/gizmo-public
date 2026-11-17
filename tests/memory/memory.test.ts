import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemory } from '../../src/memory'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gizmo-mem-')) })

describe('per-speaker memory', () => {
  it('round-trips facts for an id', () => {
    const mem = openMemory(root)
    mem.addFact('alice', 'owns the billing account')
    expect(mem.loadFacts('alice')).toContain('owns the billing account')
  })

  it('ISOLATES facts per speaker — alice’s fact never leaks to bob', () => {
    const mem = openMemory(root)
    mem.addFact('alice', 'secret: the surprise party is friday')
    expect(mem.loadFacts('bob')).toBe('') // bob sees nothing of alice's
    expect(mem.injectContext('SOUL', 'bob')).not.toContain('surprise party')
  })

  it('records and tails recent episodes in order, capped', () => {
    const mem = openMemory(root)
    for (let i = 0; i < 5; i++) mem.recordEpisode('alice', { at: i, text: `msg${i}` })
    const recent = mem.recentEpisodes('alice', 3)
    expect(recent.map((e) => e.text)).toEqual(['msg2', 'msg3', 'msg4'])
  })

  it('injectContext splices facts + recent into the soul', () => {
    const mem = openMemory(root)
    mem.addFact('alice', 'prefers Hebrew')
    mem.recordEpisode('alice', { at: 1, text: 'asked about the plumber' })
    const ctx = mem.injectContext('You are Gizmo.', 'alice')
    expect(ctx).toContain('You are Gizmo.')
    expect(ctx).toContain('prefers Hebrew')
    expect(ctx).toContain('asked about the plumber')
  })

  it('injectContext handles an unknown person gracefully', () => {
    const mem = openMemory(root)
    expect(mem.injectContext('SOUL', 'nobody')).toContain('nothing saved yet')
  })
})

describe('group (shared family) memory', () => {
  it('round-trips group facts, kept separate from any person', () => {
    const mem = openMemory(root)
    mem.addGroupFact('fam@g.us', 'Dan is married to Dana')
    expect(mem.loadGroupFacts('fam@g.us')).toContain('Dan is married to Dana')
    expect(mem.loadFacts('fam@g.us')).toBe('') // a person keyed by that same string is NOT the group store
  })

  it('injectContext adds a group section only when a group is given AND has facts', () => {
    const mem = openMemory(root)
    mem.addGroupFact('fam@g.us', 'Alex has two kids')
    mem.addFact('alice', 'prefers Hebrew')
    const withGroup = mem.injectContext('SOUL', 'alice', 'fam@g.us')
    expect(withGroup).toContain('prefers Hebrew') // personal still there
    expect(withGroup).toContain('Alex has two kids') // group facts injected
    const noGroup = mem.injectContext('SOUL', 'alice') // DM — no group context
    expect(noGroup).not.toContain('Alex has two kids')
  })

  it('writeGroupFacts replaces the whole list and backs up the previous version', () => {
    const mem = openMemory(root)
    mem.addGroupFact('fam@g.us', 'Maya born ~2013')
    mem.addGroupFact('fam@g.us', 'wrong fact to be removed')
    // Correction: rewrite with the fixed list, dropping the bad one.
    mem.writeGroupFacts('fam@g.us', ['Maya born 2013', 'Alex has two kids'])
    const now = mem.loadGroupFacts('fam@g.us')
    expect(now).toContain('Maya born 2013')
    expect(now).toContain('Alex has two kids')
    expect(now).not.toContain('wrong fact to be removed') // gone from the live sheet
    expect(now).not.toContain('~2013') // old value replaced
    // previous version is recoverable
    expect(mem.loadGroupFactsBackup('fam@g.us')).toContain('wrong fact to be removed')
  })
})
