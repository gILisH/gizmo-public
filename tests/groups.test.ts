import { describe, it, expect } from 'vitest'
import { resolveGroup, pickHouseholdGroup, makePostStager, trustedGroups, groupLabel } from '../src/groups'

const GROUPS = [
  { jid: 'fam@g.us', name: 'Familia' },
  { jid: 'groc@g.us', name: 'Grocery list' },
  { jid: 'fam2@g.us', name: 'Familia Extended' },
]

describe('resolveGroup', () => {
  it('falls back to the default when no name is given', () => {
    expect(resolveGroup(undefined, GROUPS, 'fam@g.us')).toBe('fam@g.us')
    expect(resolveGroup('', GROUPS, 'fam@g.us')).toBe('fam@g.us')
  })
  it('matches by name, case-insensitively and by substring', () => {
    expect(resolveGroup('grocery', GROUPS)).toBe('groc@g.us')
    expect(resolveGroup('FAMILIA', GROUPS)).toBe('fam@g.us')
  })
  it('prefers an exact name match over a substring match', () => {
    expect(resolveGroup('Familia', GROUPS)).toBe('fam@g.us') // not 'Familia Extended'
  })
  it('returns undefined when nothing matches and no fallback', () => {
    expect(resolveGroup('nonexistent', GROUPS)).toBeUndefined()
  })
  it('a lookalike with the exact same name is an error listing both, not a guess', () => {
    const groups = [...GROUPS, { jid: '972555001234-99@g.us', name: 'Familia', members: 2 }]
    expect(() => resolveGroup('Familia', groups)).toThrow('more than one group: Familia (…fam); Familia (…4-99, 2 members)')
  })
  it('several substring matches is an error too', () => {
    expect(() => resolveGroup('famil', GROUPS)).toThrow(/Familia.*Familia Extended/)
  })
})

describe('trustedGroups', () => {
  const all = ['fam@g.us', 'groc@g.us', 'stranger@g.us']
  it('narrows to family + allowed groups when either is set', () => {
    expect(trustedGroups(all, { familyGroups: ['fam@g.us'], allowedGroups: ['groc@g.us'] })).toEqual(['fam@g.us', 'groc@g.us'])
    expect(trustedGroups(all, { familyGroups: ['fam@g.us'], allowedGroups: [] })).toEqual(['fam@g.us'])
  })
  it('keeps every group on an unconfigured box', () => {
    expect(trustedGroups(all, { familyGroups: [], allowedGroups: [] })).toEqual(all)
  })
})

describe('groupLabel', () => {
  it('adds the jid tail and member count', () => {
    expect(groupLabel({ jid: '120363041234@g.us', name: 'Familia', members: 5 })).toBe('Familia (…1234, 5 members)')
    expect(groupLabel({ jid: '120363041234@g.us', name: 'Familia' })).toBe('Familia (…1234)')
  })
})

describe('pickHouseholdGroup', () => {
  const OWNERS = ['972gilad', '972koby']
  // family group (5 members) is most-active/first; the private owners' group is smaller.
  const members: Record<string, string[]> = {
    'fam@g.us': ['972gilad', '972koby', '972rina', '972noa', 'gizmo'], // big family group
    'private@g.us': ['972gilad', '972koby', 'gizmo'], // just the owners + bot
    'work@g.us': ['972gilad', '972boss', 'gizmo'], // missing an owner
  }
  const membersOf = (jid: string) => members[jid] ?? []

  it('picks the SMALLEST group containing all owners, not the most-active first one', () => {
    const groups = ['fam@g.us', 'private@g.us', 'work@g.us'] // fam is first (most active)
    expect(pickHouseholdGroup(groups, membersOf, OWNERS)).toBe('private@g.us')
  })
  it('ignores groups missing an owner', () => {
    expect(pickHouseholdGroup(['work@g.us', 'private@g.us'], membersOf, OWNERS)).toBe('private@g.us')
  })
  it('falls back only to a FAMILY group when none contains all owners — never an arbitrary one', () => {
    expect(pickHouseholdGroup(['work@g.us'], membersOf, OWNERS)).toBeUndefined()
    expect(pickHouseholdGroup(['work@g.us', 'x@g.us'], membersOf, OWNERS, ['x@g.us'])).toBe('x@g.us')
  })
})

describe('makePostStager', () => {
  it('sends only on confirm, once, from the DM it was staged in', async () => {
    const posts = makePostStager()
    let sent = 0
    posts.stage('dm1', 'Familia', async () => { sent++ }, 't1')
    expect(await posts.confirm('dm2', 't2')).toBe('nothing staged to send')
    expect(await posts.confirm('dm1', 't2')).toBe('sent to "Familia"')
    expect(await posts.confirm('dm1', 't2')).toBe('nothing staged to send')
    expect(sent).toBe(1)
  })
  it('refuses a confirm from the same turn that staged it, and keeps it for the next turn', async () => {
    const posts = makePostStager()
    let sent = 0
    posts.stage('dm', 'Familia', async () => { sent++ }, 't1')
    expect(await posts.confirm('dm', 't1')).toMatch(/not done: .*same turn/)
    expect(sent).toBe(0)
    expect(await posts.confirm('dm', 't2')).toBe('sent to "Familia"')
    expect(sent).toBe(1)
  })
  it('reports a failed send as a final answer instead of throwing', async () => {
    const posts = makePostStager()
    posts.stage('dm', 'Familia', async () => { throw new Error('not a participant') }, 't1')
    expect(await posts.confirm('dm', 't2')).toMatch(/couldn't send to "Familia": not a participant/)
  })
  it('cancel drops the staged send', async () => {
    const posts = makePostStager()
    posts.stage('dm', 'Familia', async () => {}, 't1')
    expect(posts.cancel('dm')).toBe('canceled the staged send')
    expect(posts.cancel('dm')).toBe('nothing was staged')
  })
})
