import { describe, it, expect } from 'vitest'
import { parseJid } from '../../src/access/jid'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAccess, MapResolver, buildResolver, scopeFor } from '../../src/access'

describe('scopeFor (ACL exemption)', () => {
  it('exempts ONLY the feed owner; everyone else is scoped to their own id', () => {
    expect(scopeFor('972500000100', '972500000100')).toBeUndefined() // Dan (feed owner) → unrestricted
    expect(scopeFor('972500000200', '972500000100')).toBe('972500000200') // Alex → scoped to himself
    expect(scopeFor('someone', '972500000100')).toBe('someone') // family → scoped
  })
})

describe('parseJid', () => {
  it('does not crash on non-string input (Baileys sometimes hands an object)', () => {
    expect(parseJid(undefined as any)).toEqual({ id: '', kind: 'other' })
    expect(parseJid({ id: 'x@lid' } as any)).toEqual({ id: '', kind: 'other' })
    expect(parseJid(123 as any)).toEqual({ id: '', kind: 'other' })
  })
  it('parses phone identities (strips device + domain)', () => {
    expect(parseJid('972500000100:5@s.whatsapp.net')).toEqual({ id: '972500000100', kind: 'pn' })
  })
  it('parses lid identities', () => {
    expect(parseJid('31500000000001:5@lid')).toEqual({ id: '31500000000001', kind: 'lid' })
  })
})

// owner (you) phone 972...898 <-> lid 31500000000001 ; partner phone 972...111
const resolver = new MapResolver({ '31500000000001': '972500000100' })
const access = makeAccess({ owners: ['972500000100', '972501111111'], allowlist: ['972502222222'] }, resolver)

describe('access gate', () => {
  it('recognizes an owner arriving as an @lid (LID→phone)', () => {
    expect(access.isOwner('31500000000001:5@lid')).toBe(true)
    expect(access.corpusScope('31500000000001:5@lid')).toBe('full')
  })
  it('recognizes an owner by phone JID', () => {
    expect(access.isOwner('972501111111@s.whatsapp.net')).toBe(true)
  })
  it('family (allowlisted, not owner) is allowed but scoped to own', () => {
    expect(access.isOwner('972502222222@s.whatsapp.net')).toBe(false)
    expect(access.isAllowed('972502222222@s.whatsapp.net')).toBe(true)
    expect(access.corpusScope('972502222222@s.whatsapp.net')).toBe('own')
  })
  it('unknown sender is neither owner nor allowed', () => {
    expect(access.isAllowed('972509999999@s.whatsapp.net')).toBe(false)
    expect(access.isOwner('99999999999:1@lid')).toBe(false) // unresolvable lid → own id, not owner
  })
  it('group tier: all-owner room = owner; mixed room = family', () => {
    expect(access.groupTier(['31500000000001:5@lid', '972501111111@s.whatsapp.net'])).toBe('owner')
    expect(access.groupTier(['972501111111@s.whatsapp.net', '972502222222@s.whatsapp.net'])).toBe('family')
  })
})

describe('buildResolver', () => {
  it('reads per-owner lid-mapping files (lid → phone)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gizmo-creds-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'lid-mapping-972500000200.json'), JSON.stringify('212900000000002'))
    const r = buildResolver({ credsDirs: [], lidMapDir: dir, ownerPhones: ['972500000200'] })
    expect(r.toPhone('212900000000002:7@lid')).toBe('972500000200') // Alex's lid → phone
    expect(r.toPhone('999@lid')).toBeNull()
  })
})
