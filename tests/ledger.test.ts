import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, makeFx, parseRates, type Ledger } from '../src/ledger'
import { ledgerTools } from '../src/brain/tools/ledger'
import { buildTools, buildSystem } from '../src/brain'
import type { BrainDeps } from '../src/brain/types'

const KIDS = [
  { name: 'Eden', aliases: ['עדן'] },
  { name: 'Omer', aliases: ['עומר'] },
]
const SEED = (l: Ledger) => {
  l.add({ kid: 'Eden', category: 'opening', amount: 522, description: 'opening balance' })
  l.add({ kid: 'Omer', category: 'opening', amount: 573, description: 'opening balance' })
}
const NOW = Date.UTC(2026, 10, 13, 10) // 2026-11-13
const path = () => join(mkdtempSync(join(tmpdir(), 'gizmo-ledger-')), 'ledger.json')
const open = (p = path()) => openLedger(p, { kids: KIDS, seed: SEED, now: () => NOW })
const call = (t: any, args: any = {}) => t.execute(args, { toolCallId: 't', messages: [] })

describe('ledger store', () => {
  it('rolls back a seed that fails halfway, so the next start retries cleanly', () => {
    const p = path()
    const bad = (l: Ledger) => {
      l.add({ kid: 'Eden', category: 'gift', amount: 5, description: 'x' })
      throw new Error('boom')
    }
    expect(() => openLedger(p, { kids: KIDS, seed: bad, now: () => NOW })).toThrow('boom')
    expect(open(p).balance('Eden')).toBe(522)
  })

  it('seeds the migrated balances exactly once', () => {
    const p = path()
    const l = open(p)
    expect(l.balance('Eden')).toBe(522)
    expect(l.balance('Omer')).toBe(573)
    expect(l.history()).toHaveLength(2)
    expect(l.history()[0]).toMatchObject({ kid: 'Eden', category: 'opening', date: '2026-11-13', balanceIls: 522 })
    // Re-opening (a restart) must NOT credit again.
    const again = open(p)
    expect(again.balance('Eden')).toBe(522)
    expect(again.history()).toHaveLength(2)
  })

  it('purchases subtract, income adds, running balance per entry, persisted', () => {
    const p = path()
    const l = open(p)
    const buy = l.add({ kid: 'עדן', category: 'purchase', amount: 10, currency: 'usd', rate: 3.7, description: 'Lego', source: 'USA dollars' })
    expect(buy).toMatchObject({ kid: 'Eden', amount: -10, currency: 'USD', amountIls: -37, balanceIls: 485, source: 'USA dollars' })
    const gift = l.add({ kid: 'Eden', category: 'gift', amount: 50, description: 'from savta', source: 'gifts' })
    expect(gift.balanceIls).toBe(535)
    expect(open(p).balance('Eden')).toBe(535) // survives reopen
    expect(JSON.parse(readFileSync(p, 'utf8')).entries).toHaveLength(4)
  })

  it('transfer creates two linked legs', () => {
    const l = open()
    const [out, inn] = l.transfer({ from: 'Omer', to: 'Eden', amount: 20, description: 'paid back' })
    expect(out).toMatchObject({ kid: 'Omer', amountIls: -20, category: 'transfer', balanceIls: 553 })
    expect(inn).toMatchObject({ kid: 'Eden', amountIls: 20, balanceIls: 542, transferId: out.transferId })
    expect(() => l.transfer({ from: 'Eden', to: 'eden', amount: 1, description: 'x' })).toThrow(/two different/)
  })

  it('breakdown by source; adjustment may be signed', () => {
    const l = open()
    l.add({ kid: 'Omer', category: 'top-up', amount: 100, description: 'left from the trip', source: 'trip leftover' })
    l.add({ kid: 'Omer', category: 'purchase', amount: 30, description: 'snack', source: 'trip leftover' })
    l.add({ kid: 'Omer', category: 'adjustment', amount: -3, description: 'rounding fix' })
    expect(l.breakdown('Omer')).toEqual([
      { source: 'general', ils: 570 },
      { source: 'trip leftover', ils: 70 },
    ])
    expect(l.balance('Omer')).toBe(640)
  })

  it('history filters by kid and inclusive date range, limited to the latest', () => {
    const l = open()
    l.add({ kid: 'Eden', category: 'purchase', amount: 5, description: 'a', date: '2026-10-01' })
    l.add({ kid: 'Eden', category: 'purchase', amount: 6, description: 'b', date: '2026-10-15' })
    l.add({ kid: 'Omer', category: 'purchase', amount: 7, description: 'c', date: '2026-10-15' })
    expect(l.history({ kid: 'Eden', from: '2026-10-01', to: '2026-10-15' }).map((e) => e.description)).toEqual(['a', 'b'])
    expect(l.history({ from: '2026-10-15', to: '2026-10-15' }).map((e) => e.description)).toEqual(['b', 'c'])
    expect(l.history({ limit: 1 }).map((e) => e.description)).toEqual(['c'])
  })

  it('rejects bad input instead of corrupting the ledger', () => {
    const l = open()
    expect(() => l.add({ kid: 'Lia', category: 'gift', amount: 1, description: 'x' })).toThrow(/unknown kid/)
    expect(() => l.add({ kid: 'Eden', category: 'purchase', amount: -5, description: 'x' })).toThrow(/positive/)
    expect(() => l.add({ kid: 'Eden', category: 'purchase', amount: 5, currency: 'USD', description: 'x' })).toThrow(/rate/)
    expect(() => l.add({ kid: 'Eden', category: 'purchase', amount: 5, description: 'x', date: '13/11' })).toThrow(/YYYY-MM-DD/)
    expect(l.history()).toHaveLength(2)
  })
})

describe('fx', () => {
  it('parses configured rates', () => {
    expect(parseRates('usd=3.7, EUR=4.05,bad,X=-1')).toEqual({ USD: 3.7, EUR: 4.05 })
  })

  it('ILS=1, configured rate wins, live rate is cached', async () => {
    let fetches = 0
    let t = 0
    const fx = makeFx({ fixed: { USD: 3.7 }, fetchRate: async () => (fetches++, 4.1), ttlMs: 1000, now: () => t })
    expect(await fx('ils')).toBe(1)
    expect(await fx('USD')).toBe(3.7)
    expect(await fx('EUR')).toBe(4.1)
    expect(await fx('eur')).toBe(4.1)
    expect(fetches).toBe(1)
    t = 2000
    await fx('EUR')
    expect(fetches).toBe(2)
    await expect(makeFx({})('GBP')).rejects.toThrow(/no rate/)
  })
})

describe('ledger tools', () => {
  const deps = (fx?: (c: string) => Promise<number>) => ({ ledger: open(), fxToIls: fx ?? (async () => 3.5) }) as unknown as BrainDeps

  it('owner can add (with automatic conversion); balance + history read it back', async () => {
    const d = deps()
    const t: any = ledgerTools(d, 'owner', { isOwner: true })
    const out = await call(t.ledger_add, { kid: 'Eden', type: 'purchase', amount: 20, currency: 'USD', description: 'sneakers', source: 'USA dollars' })
    expect(out).toContain('recorded #3')
    expect(out).toContain('-₪70.00 (-20 USD @ 3.5)')
    expect(out).toContain('balance ₪452.00')
    expect(await call(t.ledger_balance, {})).toBe('Eden: ₪452.00\nOmer: ₪573.00')
    expect(await call(t.ledger_balance, { kid: 'eden', breakdown: true })).toBe('Eden: ₪452.00\n  · general: ₪522.00\n  · USA dollars: -₪70.00')
    expect(await call(t.ledger_history, { kid: 'Eden' })).toMatch(/sneakers \[USA dollars\]/)
  })

  it('over-budget purchase is NOT recorded unless confirmed', async () => {
    const d = deps()
    const t: any = ledgerTools(d, 'owner', { isOwner: true })
    const warn = await call(t.ledger_add, { kid: 'Omer', type: 'purchase', amount: 600, description: 'bike' })
    expect(warn).toContain('over budget')
    expect(warn).toContain('short ₪27.00')
    expect(d.ledger!.balance('Omer')).toBe(573)
    const ok = await call(t.ledger_add, { kid: 'Omer', type: 'purchase', amount: 600, description: 'bike', confirmOverBudget: true })
    expect(ok).toContain('now in the negative (-₪27.00)')
    expect(d.ledger!.balance('Omer')).toBe(-27)
  })

  it('transfer between kids, gated by the giver balance too', async () => {
    const d = deps()
    const t: any = ledgerTools(d, 'owner', { isOwner: true })
    expect(await call(t.ledger_add, { kid: 'Eden', type: 'transfer', amount: 10, description: 'x' })).toMatch(/needs toKid/)
    expect(await call(t.ledger_add, { kid: 'Eden', type: 'transfer', toKid: 'Omer', amount: 999, description: 'x' })).toMatch(/over budget/)
    const out = await call(t.ledger_add, { kid: 'Eden', type: 'transfer', toKid: 'עומר', amount: 22, description: 'birthday share' })
    expect(out).toContain('recorded transfer')
    expect(d.ledger!.balance('Eden')).toBe(500)
    expect(d.ledger!.balance('Omer')).toBe(595)
  })

  it('asks for a rate when none can be fetched; an explicit rate overrides', async () => {
    const d = deps(async () => { throw new Error('offline') })
    const t: any = ledgerTools(d, 'owner', { isOwner: true })
    expect(await call(t.ledger_add, { kid: 'Eden', type: 'gift', amount: 10, currency: 'EUR', description: 'x' })).toMatch(/couldn't get a EUR→ILS rate.*pass it as rate/)
    expect(d.ledger!.history()).toHaveLength(2)
    expect(await call(t.ledger_add, { kid: 'Eden', type: 'gift', amount: 10, currency: 'EUR', rate: 4, description: 'x' })).toContain('+₪40.00')
  })

  it('unknown kid is reported, not guessed', async () => {
    const t: any = ledgerTools(deps(), 'owner', { isOwner: true })
    expect(await call(t.ledger_balance, { kid: 'Lia' })).toMatch(/Eden \/ Omer/)
    expect(await call(t.ledger_add, { kid: 'Lia', type: 'gift', amount: 1, description: 'x' })).toMatch(/don't have a ledger/)
  })

  it('gating: owners only; non-owners, guests and no-ledger get nothing', () => {
    expect(ledgerTools(deps(), 'kid', { isOwner: false })).toEqual({})
    expect(ledgerTools(deps(), 'g', { isOwner: true, guest: true })).toEqual({})
    expect(ledgerTools({} as BrainDeps, 'owner', { isOwner: true })).toEqual({})
  })

  it('in groups: only the household group, never a wider family group', () => {
    const d = { ...deps(), householdGroup: () => 'house@g.us' } as unknown as BrainDeps
    expect(Object.keys(ledgerTools(d, 'owner', { isOwner: true, inGroup: true, chatJid: 'house@g.us' }))).toContain('ledger_balance')
    expect(ledgerTools(d, 'owner', { isOwner: true, inGroup: true, chatJid: 'bigfamily@g.us' })).toEqual({})
    expect(ledgerTools(deps(), 'owner', { isOwner: true, inGroup: true, chatJid: 'house@g.us' })).toEqual({}) // no household known
    const memory = { injectContext: (s: string) => s, loadGroupFacts: () => '' } as any
    const big = buildSystem({ soul: 'S', memory, ledger: open(), householdGroup: () => 'house@g.us' }, 'owner', new Date(NOW), { isOwner: true, inGroup: true, groupChatJid: 'bigfamily@g.us' })
    expect(big).not.toContain('ledger_')
    expect(big).toContain('private to the parents')
  })

  it('is composed into buildTools', () => {
    const base = { ...deps(), memory: { addFact() {} } } as unknown as BrainDeps
    expect(Object.keys(buildTools(base, 'owner', { isOwner: true }))).toEqual(expect.arrayContaining(['ledger_add', 'ledger_balance', 'ledger_history']))
  })
})

describe('system prompt', () => {
  const memory = { injectContext: (s: string) => s, loadGroupFacts: () => '' } as any
  it('steers pocket money to the ledger, not remember (when the ledger exists)', () => {
    const sys = buildSystem({ soul: 'S', memory, ledger: open() }, 'owner', new Date(NOW), { isOwner: true })
    expect(sys).toContain('## Pocket money (Eden and Omer)')
    expect(sys).toContain('NEVER use remember')
    expect(sys).toContain('ledger_add')
    // Non-owner: no ledger tools mentioned, told balances are private.
    const kid = buildSystem({ soul: 'S', memory, ledger: open() }, 'kid', new Date(NOW), {})
    expect(kid).not.toContain('ledger_')
    expect(kid).toContain('private to the parents')
    expect(buildSystem({ soul: 'S', memory }, 'owner', new Date(NOW), { isOwner: true })).not.toContain('Pocket money')
    // Guests never see family finances.
    expect(buildSystem({ soul: 'S', memory, ledger: open() }, 'g', new Date(NOW), { guest: true })).not.toContain('Pocket money')
  })
})
