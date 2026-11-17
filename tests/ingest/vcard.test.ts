import { describe, it, expect } from 'vitest'
import { parseVCards, normalizePhone } from '../../src/ingest/vcard'

describe('normalizePhone', () => {
  it('normalizes local, international, and messy formats to E.164 digits', () => {
    expect(normalizePhone('052-123-4567')).toBe('972521234567') // Israeli local → intl
    expect(normalizePhone('+972 52 123 4567')).toBe('972521234567')
    expect(normalizePhone('00972521234567')).toBe('972521234567')
    expect(normalizePhone('+1 (415) 555-0100')).toBe('14155550100') // other country kept
    expect(normalizePhone('123')).toBeNull() // too short
  })
})

describe('parseVCards', () => {
  it('extracts FN + all TEL numbers, dedupes, handles multiple cards', () => {
    const vcf = `BEGIN:VCARD
VERSION:3.0
FN:Asia Cohen
TEL;TYPE=CELL:052-987-6543
TEL;TYPE=HOME:+972529876543
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Alex
TEL:050-000-0200
END:VCARD`
    const cards = parseVCards(vcf)
    expect(cards).toHaveLength(2)
    expect(cards[0]).toEqual({ name: 'Asia Cohen', phones: ['972529876543'] }) // two TELs → same normalized number, deduped
    expect(cards[1]).toEqual({ name: 'Alex', phones: ['972500000200'] })
  })

  it('falls back to N when FN is absent, and unfolds continuation lines', () => {
    const vcf = 'BEGIN:VCARD\r\nN:Levi;Dana;;;\r\nTEL:\r\n +972-50-000-0000\r\nEND:VCARD'
    expect(parseVCards(vcf)).toEqual([{ name: 'Dana Levi', phones: ['972500000000'] }])
  })

  it('skips cards with no name or no phone', () => {
    expect(parseVCards('BEGIN:VCARD\nFN:No Phone\nEND:VCARD')).toEqual([])
    expect(parseVCards('BEGIN:VCARD\nTEL:0501234567\nEND:VCARD')).toEqual([])
  })
})
