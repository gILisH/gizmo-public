import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// The kids' pocket-money ledger: a structured, append-only list of entries per kid with a
// running balance in ILS. Replaces the old free-text memory notes ("Eden has 522, spent 40
// on…"), which drifted, duplicated and couldn't be audited. Code owns the arithmetic and the
// over-budget check; the model only decides WHAT to record.

export const CATEGORIES = ['purchase', 'gift', 'top-up', 'allowance', 'transfer', 'adjustment', 'opening'] as const
export type LedgerCategory = (typeof CATEGORIES)[number]

export interface LedgerEntry {
  id: number
  kid: string // canonical kid name, e.g. "Eden"
  date: string // YYYY-MM-DD (the day it happened, home time)
  recordedAt: number // unix ms when it was written
  description: string
  amount: number // signed, in the ORIGINAL currency (negative = money out)
  currency: string // ISO code, e.g. "ILS", "USD"
  rate: number // ILS per 1 unit of `currency` used for the conversion
  amountIls: number // signed, rounded to agorot
  category: LedgerCategory
  source?: string // which pot it belongs to: "trip leftover", "USA dollars", "gifts"…
  transferId?: number // links the two legs of a transfer between kids
  balanceIls: number // the kid's running balance right after this entry
}

export interface KidConfig {
  name: string
  aliases?: string[] // other spellings that resolve to this kid (Hebrew, nicknames)
}

export interface NewEntry {
  kid: string
  description: string
  amount: number // positive magnitude; sign comes from the category (adjustment may be signed)
  currency?: string
  rate?: number // ILS per unit; required unless currency is ILS
  category: Exclude<LedgerCategory, 'transfer'>
  source?: string
  date?: string
}

export interface NewTransfer {
  from: string
  to: string
  description: string
  amount: number
  currency?: string
  rate?: number
  source?: string
  date?: string
}

export interface Ledger {
  kids(): string[]
  resolveKid(name: string): string | undefined
  add(e: NewEntry): LedgerEntry
  transfer(t: NewTransfer): [LedgerEntry, LedgerEntry]
  balance(kid: string): number
  breakdown(kid: string): Array<{ source: string; ils: number }>
  history(q?: { kid?: string; from?: string; to?: string; limit?: number }): LedgerEntry[]
}

interface LedgerFile {
  version: 1
  seeded: boolean
  nextId: number
  entries: LedgerEntry[]
}

const INCOMING: LedgerCategory[] = ['gift', 'top-up', 'allowance', 'opening']
export const GENERAL_SOURCE = 'general'
export const round2 = (n: number) => Math.round(n * 100) / 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Today as YYYY-MM-DD in `tz` (en-CA formats dates as ISO).
export function localDate(ms: number, tz = 'Asia/Jerusalem'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

// Opens (or creates) the ledger JSON at `path`. `seed` is the ONE-TIME migration of the
// history that used to live in memory notes: run only on the first open (the file records
// `seeded`), so restarts never double-credit. A seed that throws is rolled back whole.
export function openLedger(
  path: string,
  opts: { kids: KidConfig[]; seed?: (l: Ledger) => void; now?: () => number; tz?: string },
): Ledger {
  const now = opts.now ?? (() => Date.now())
  const kids = opts.kids
  const data: LedgerFile = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as LedgerFile)
    : { version: 1, seeded: false, nextId: 1, entries: [] }

  const persist = () => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 1))
    renameSync(tmp, path) // atomic: a crash mid-write never leaves a half ledger
  }

  const norm = (s: string) => s.trim().toLowerCase()
  const resolveKid = (name: string) =>
    kids.find((k) => [k.name, ...(k.aliases ?? [])].some((n) => norm(n) === norm(name)))?.name
  const mustKid = (name: string) => {
    const k = resolveKid(name)
    if (!k) throw new Error(`unknown kid "${name}" — the ledger has ${kids.map((k) => k.name).join(', ')}`)
    return k
  }
  const balance = (kid: string) => {
    const k = mustKid(kid)
    return round2(data.entries.filter((e) => e.kid === k).reduce((s, e) => s + e.amountIls, 0))
  }
  const toIls = (amount: number, currency: string, rate?: number) => {
    if (!Number.isFinite(amount)) throw new Error('amount must be a number')
    const r = currency === 'ILS' ? 1 : rate
    if (!r || !Number.isFinite(r) || r <= 0) throw new Error(`no ILS rate for ${currency}`)
    return { rate: r, ils: round2(amount * r) }
  }
  const dateOf = (d?: string) => {
    if (d === undefined) return localDate(now(), opts.tz)
    if (!DATE_RE.test(d)) throw new Error(`date must be YYYY-MM-DD, got "${d}"`)
    return d
  }
  const push = (e: Omit<LedgerEntry, 'id' | 'recordedAt' | 'balanceIls'>): LedgerEntry => {
    const entry: LedgerEntry = { id: data.nextId++, recordedAt: now(), ...e, balanceIls: round2(balance(e.kid) + e.amountIls) }
    if (!entry.source) delete entry.source
    if (entry.transferId === undefined) delete entry.transferId
    data.entries.push(entry)
    return entry
  }

  const api: Ledger = {
    kids: () => kids.map((k) => k.name),
    resolveKid,
    balance,
    add(e) {
      const kid = mustKid(e.kid)
      const currency = (e.currency ?? 'ILS').toUpperCase()
      if (e.category === 'adjustment' ? !e.amount : !(e.amount > 0)) throw new Error(e.category === 'adjustment' ? 'adjustment amount must be non-zero' : 'amount must be positive')
      const { rate, ils } = toIls(Math.abs(e.amount), currency, e.rate)
      const sign = e.category === 'adjustment' ? Math.sign(e.amount) : INCOMING.includes(e.category) ? 1 : -1
      const entry = push({
        kid, date: dateOf(e.date), description: e.description.trim(), amount: sign * Math.abs(e.amount), currency, rate,
        amountIls: sign * ils, category: e.category, source: e.source?.trim() || undefined,
      })
      persist()
      return entry
    },
    transfer(t) {
      const from = mustKid(t.from)
      const to = mustKid(t.to)
      if (from === to) throw new Error('a transfer needs two different kids')
      if (!(t.amount > 0)) throw new Error('amount must be positive')
      const currency = (t.currency ?? 'ILS').toUpperCase()
      const { rate, ils } = toIls(t.amount, currency, t.rate)
      const date = dateOf(t.date)
      const transferId = data.nextId
      const base = { date, currency, rate, category: 'transfer' as const, source: t.source?.trim() || undefined, transferId }
      const out = push({ ...base, kid: from, description: `${t.description.trim()} → ${to}`, amount: -t.amount, amountIls: -ils })
      const inn = push({ ...base, kid: to, description: `${t.description.trim()} ← ${from}`, amount: t.amount, amountIls: ils })
      persist()
      return [out, inn]
    },
    breakdown(kid) {
      const k = mustKid(kid)
      const by = new Map<string, number>()
      for (const e of data.entries.filter((e) => e.kid === k)) {
        const s = e.source ?? GENERAL_SOURCE
        by.set(s, (by.get(s) ?? 0) + e.amountIls)
      }
      return [...by].map(([source, ils]) => ({ source, ils: round2(ils) }))
    },
    history(q = {}) {
      const kid = q.kid ? mustKid(q.kid) : undefined
      const hits = data.entries.filter(
        (e) => (!kid || e.kid === kid) && (!q.from || e.date >= q.from) && (!q.to || e.date <= q.to),
      )
      return hits.slice(-(q.limit ?? 20))
    },
  }

  if (!data.seeded) {
    const n = data.entries.length
    const id = data.nextId
    try {
      opts.seed?.(api)
    } catch (e) {
      data.entries.length = n
      data.nextId = id
      persist()
      throw e
    }
    data.seeded = true
    persist()
  }
  return api
}

// "USD=3.7,EUR=4.05" → { USD: 3.7, EUR: 4.05 } (GIZMO_FX_RATES).
export function parseRates(s?: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (s ?? '').split(',')) {
    const [cur, val] = part.split('=').map((x) => x?.trim())
    const n = Number(val)
    if (cur && Number.isFinite(n) && n > 0) out[cur.toUpperCase()] = n
  }
  return out
}

// ILS per 1 unit of a currency. Order: ILS=1 → a configured rate (GIZMO_FX_RATES, the owner's
// explicit choice) → a live fetch (cached for `ttlMs`). Throws when none is available, so the
// tool can ask for a rate instead of guessing one.
export function makeFx(opts: {
  fixed?: Record<string, number>
  fetchRate?: (currency: string) => Promise<number>
  ttlMs?: number
  now?: () => number
}): (currency: string) => Promise<number> {
  const cache = new Map<string, { rate: number; at: number }>()
  const ttl = opts.ttlMs ?? 6 * 3600_000
  const now = opts.now ?? (() => Date.now())
  return async (currency) => {
    const cur = currency.trim().toUpperCase()
    if (cur === 'ILS') return 1
    const fixed = opts.fixed?.[cur]
    if (fixed) return fixed
    const hit = cache.get(cur)
    if (hit && now() - hit.at < ttl) return hit.rate
    if (!opts.fetchRate) throw new Error(`no rate configured for ${cur}`)
    const rate = await opts.fetchRate(cur)
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`bad rate for ${cur}`)
    cache.set(cur, { rate, at: now() })
    return rate
  }
}

// Live rate from open.er-api.com (free, no key). Used only when no rate is configured.
export async function fetchIlsRate(currency: string): Promise<number> {
  const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(currency)}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`rate fetch failed (${res.status})`)
  const body = (await res.json()) as { rates?: Record<string, number> }
  const r = body.rates?.ILS
  if (!r) throw new Error(`no ILS rate for ${currency}`)
  return r
}
