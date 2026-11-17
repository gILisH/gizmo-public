import { describe, it, expect } from 'vitest'
import { toMemberIds } from '../../src/transport/group-sync'

describe('toMemberIds', () => {
  it('keeps plain string jids', () => {
    expect(toMemberIds(['a@lid', 'b@s.whatsapp.net'])).toEqual(['a@lid', 'b@s.whatsapp.net'])
  })
  it('extracts .id from object participants (Baileys 7 LID form)', () => {
    expect(toMemberIds([{ id: 'a@lid' }, { id: 'b@lid' }])).toEqual(['a@lid', 'b@lid'])
  })
  it('handles a mix and drops anything without a usable id', () => {
    expect(toMemberIds(['a@lid', { id: 'b@lid' }, {}, null, 123, ''])).toEqual(['a@lid', 'b@lid'])
  })
  it('returns [] for a non-array', () => {
    expect(toMemberIds(undefined as any)).toEqual([])
  })
})
