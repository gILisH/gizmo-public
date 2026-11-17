import { describe, it, expect } from 'vitest'
import { isGuestGroup, mayRespond, maySubscribe, searchScope } from '../src/policy'

describe('mayRespond — who Gizmo answers, and where', () => {
  it('group: answers ANY member, but only when addressed AND the group is allowed', () => {
    expect(mayRespond({ isGroup: true, mentionsMe: true, isOwner: false, groupAllowed: true })).toBe(true) // family in-group
    expect(mayRespond({ isGroup: true, mentionsMe: true, isOwner: true, groupAllowed: true })).toBe(true)
    expect(mayRespond({ isGroup: true, mentionsMe: false, isOwner: true, groupAllowed: true })).toBe(false) // not addressed
  })
  it('group: silent in a NON-allowed group even when addressed', () => {
    expect(mayRespond({ isGroup: true, mentionsMe: true, isOwner: true, groupAllowed: false })).toBe(false)
  })
  it('DM: owners only — allowlist irrelevant', () => {
    expect(mayRespond({ isGroup: false, mentionsMe: false, isOwner: true, groupAllowed: false })).toBe(true)
    expect(mayRespond({ isGroup: false, mentionsMe: false, isOwner: false, groupAllowed: true })).toBe(false) // family DM → silence
  })
})

describe('searchScope — full corpus vs one chat', () => {
  it('feed owner in their private DM → full corpus (undefined)', () => {
    expect(searchScope({ isFeedOwner: true, isGroup: false, chatJid: 'dm@lid' })).toBeUndefined()
  })
  it('feed owner INSIDE a group → scoped to that group (no cross-chat leak)', () => {
    expect(searchScope({ isFeedOwner: true, isGroup: true, chatJid: 'fam@g.us' })).toBe('fam@g.us')
  })
  it('everyone else → scoped to the chat they are in', () => {
    expect(searchScope({ isFeedOwner: false, isGroup: true, chatJid: 'fam@g.us' })).toBe('fam@g.us')
    expect(searchScope({ isFeedOwner: false, isGroup: false, chatJid: 'alex-dm@lid' })).toBe('alex-dm@lid')
  })
})

describe('isGuestGroup — family groups vs everyone else', () => {
  it('a group not listed as family is a guest group', () => {
    expect(isGuestGroup({ isGroup: true, chatJid: 'work@g.us', familyGroups: ['fam@g.us'] })).toBe(true)
    expect(isGuestGroup({ isGroup: true, chatJid: 'fam@g.us', familyGroups: ['fam@g.us'] })).toBe(false)
  })
  it('fail-closed: no family groups configured → every group is a guest group', () => {
    expect(isGuestGroup({ isGroup: true, chatJid: 'fam@g.us', familyGroups: [] })).toBe(true)
  })
  it('a DM is never a guest group', () => {
    expect(isGuestGroup({ isGroup: false, chatJid: 'dm@lid', familyGroups: [] })).toBe(false)
  })
})

describe('maySubscribe — who runs on the owner\'s Claude subscription', () => {
  it('feed owner\'s DM and any (admitted) group: yes; anyone else\'s DM: no', () => {
    expect(maySubscribe({ isGroup: false, isFeedOwner: true })).toBe(true)
    expect(maySubscribe({ isGroup: true, isFeedOwner: false })).toBe(true)
    expect(maySubscribe({ isGroup: false, isFeedOwner: false })).toBe(false)
  })
})
