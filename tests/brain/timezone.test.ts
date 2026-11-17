import { describe, it, expect } from 'vitest'
import { localDateLine, parseDayRange, parseWhen, fmtMsg, isValidTz } from '../../src/brain/format'
import { openStore } from '../../src/store'

// The real incident: 2026-11-04 01:46 UTC = Tue Nov 3, 20:46 in Boston, Wed 03:46 in Israel.
const now = new Date('2026-11-04T01:46:00Z')
const NY = 'America/New_York'

describe('per-chat timezone', () => {
  it('a chat in Boston sees Boston\'s date and time, not Israel\'s or the server\'s', () => {
    expect(localDateLine(now, NY)).toContain('Current date: 2026-11-03 (Tuesday), local time 20:46 America/New_York (UTC-05:00)')
    expect(localDateLine(now)).toContain('Current date: 2026-11-04 (Wednesday), local time 03:46 Asia/Jerusalem (UTC+02:00)')
  })

  it('an offset-less reminder time is that chat\'s wall clock', () => {
    expect(parseWhen('2026-11-04T09:00', NY)).toBe(Date.parse('2026-11-04T14:00:00Z') / 1000)
    expect(parseWhen('2026-11-04T09:00')).toBe(Date.parse('2026-11-04T07:00:00Z') / 1000)
    expect(parseWhen('2026-11-04T09:00:00Z', NY)).toBe(Date.parse('2026-11-04T09:00:00Z') / 1000) // explicit offset wins
    expect(parseWhen('2026-10-31T09:00', NY)).toBe(Date.parse('2026-10-31T13:00:00Z') / 1000) // before US DST ended
    expect(Number.isNaN(parseWhen('soon', NY))).toBe(true)
  })

  it('day ranges and history stamps follow the chat timezone', () => {
    expect(parseDayRange('2026-11-03', undefined, NY)).toEqual([Date.parse('2026-11-03T05:00:00Z') / 1000, Date.parse('2026-11-04T05:00:00Z') / 1000 - 1])
    expect(parseDayRange('2026-11-01', undefined, NY)[1] - parseDayRange('2026-11-01', undefined, NY)[0]).toBe(25 * 3600 - 1) // DST-end day is 25h
    expect(fmtMsg({ ts: now.getTime() / 1000, chatJid: 'x@g.us', senderName: 'Dan', text: 'hi' }, NY)).toBe('[2026-11-03 20:46 · group] Dan: hi')
  })

  it('stores a chat timezone and clears it back to home', () => {
    const store = openStore(':memory:', { embedDim: 4 })
    expect(store.getChatTz('g@g.us')).toBeUndefined()
    store.setChatTz('g@g.us', NY)
    expect(store.getChatTz('g@g.us')).toBe(NY)
    store.setChatTz('g@g.us', null)
    expect(store.getChatTz('g@g.us')).toBeUndefined()
    expect(isValidTz(NY)).toBe(true)
    expect(isValidTz('Boston')).toBe(false)
  })
})
