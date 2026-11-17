import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { GENERAL_SOURCE, round2, type LedgerEntry } from '../../ledger'

const ils = (n: number) => `${n < 0 ? '-' : ''}₪${Math.abs(n).toFixed(2)}`

export function fmtEntry(e: LedgerEntry): string {
  const orig = e.currency === 'ILS' ? '' : ` (${e.amount} ${e.currency} @ ${e.rate})`
  const src = e.source && e.source !== GENERAL_SOURCE ? ` [${e.source}]` : ''
  return `#${e.id} ${e.date} ${e.kid} · ${e.category} ${e.amountIls >= 0 ? '+' : ''}${ils(e.amountIls)}${orig} — ${e.description}${src} → balance ${ils(e.balanceIls)}`
}

// The kids' pocket-money ledger. Balances/purchases live HERE, not in memory notes.
// Owners only (Dan + Alex), reading included: balances aren't shared with the wider family.
// Only in an owner's DM or the household (owners') group — never a wider family group, where
// the answer would land in front of everyone. Never in a guest group. Over-budget is enforced in code: a purchase/transfer larger than
// the balance is NOT recorded unless the call explicitly confirms it.
export const ledgerAllowed = (deps: Partial<Pick<BrainDeps, 'householdGroup'>>, ctx: { isOwner?: boolean; guest?: boolean; inGroup?: boolean; chatJid?: string }) =>
  Boolean(ctx.isOwner && !ctx.guest && (!ctx.inGroup || (ctx.chatJid && ctx.chatJid === deps.householdGroup?.())))

export function ledgerTools(deps: BrainDeps, _id: string, ctx: ToolCtx): ToolSet {
  const ledger = deps.ledger
  if (!ledger || !ledgerAllowed(deps, ctx)) return {}
  const kidNames = ledger.kids().join(' / ')
  const kidArg = z.string().describe(`which kid: ${kidNames}`)
  const unknown = (k: string) => `I don't have a ledger for "${k}" — the kids are ${kidNames}`

  const rateFor = async (currency: string, override?: number): Promise<number | string> => {
    if (currency === 'ILS') return 1
    if (override) return override
    if (!deps.fxToIls) return `I have no ${currency}→ILS rate — ask what rate to use and pass it as rate`
    try {
      return await deps.fxToIls(currency)
    } catch (e) {
      return `couldn't get a ${currency}→ILS rate (${(e as Error).message}) — ask what rate to use and pass it as rate`
    }
  }

  const tools: ToolSet = {
    ledger_balance: tool({
      description: `Current pocket-money balance (in ILS) for ${kidNames} — the authoritative number; never answer balances from memory notes. Omit kid for everyone. breakdown:true splits it by source/pot (e.g. trip leftover, USA dollars, gifts).`,
      inputSchema: z.object({
        kid: kidArg.optional(),
        breakdown: z.boolean().optional().describe('also show the balance per source/pot'),
      }),
      execute: async ({ kid, breakdown }) => {
        const k = kid ? ledger.resolveKid(kid) : undefined
        if (kid && !k) return unknown(kid)
        return (k ? [k] : ledger.kids())
          .map((name) => {
            const head = `${name}: ${ils(ledger.balance(name))}`
            if (!breakdown) return head
            const parts = ledger.breakdown(name).filter((p) => p.ils !== 0).map((p) => `  · ${p.source}: ${ils(p.ils)}`)
            return [head, ...parts].join('\n')
          })
          .join('\n')
      },
    }),
    ledger_history: tool({
      description: 'Recent pocket-money ledger entries (purchases, gifts, top-ups, transfers), newest last. Filter by kid and/or a date range (YYYY-MM-DD, inclusive).',
      inputSchema: z.object({
        kid: kidArg.optional(),
        from: z.string().optional().describe('YYYY-MM-DD, inclusive'),
        to: z.string().optional().describe('YYYY-MM-DD, inclusive'),
        limit: z.number().int().min(1).max(100).optional().describe('max entries (default 20)'),
      }),
      execute: async ({ kid, from, to, limit }) => {
        const k = kid ? ledger.resolveKid(kid) : undefined
        if (kid && !k) return unknown(kid)
        const rows = ledger.history({ kid: k, from, to, limit: limit ?? 20 })
        return rows.length ? rows.map(fmtEntry).join('\n') : 'no ledger entries match'
      },
    }),
  }

  tools.ledger_add = tool({
    description: `Record pocket money for ${kidNames}: a purchase (money out), gift / top-up / allowance (money in), a transfer between the kids (set toKid), or an adjustment (signed correction). Use THIS — never remember — for balances and spending. Foreign currency is converted to ILS automatically (or pass rate). If a purchase/transfer exceeds the balance it is NOT recorded and you get a warning: tell the owner and only retry with confirmOverBudget:true if they say so.`,
    inputSchema: z.object({
      kid: kidArg.describe(`whose money (for a transfer: the kid GIVING): ${kidNames}`),
      type: z.enum(['purchase', 'gift', 'top-up', 'allowance', 'transfer', 'adjustment']),
      amount: z.number().describe('positive amount in `currency` (adjustment may be negative)'),
      currency: z.string().optional().describe('ISO code, default ILS (e.g. USD, EUR)'),
      description: z.string().describe('what it was, e.g. "Lego set at the mall"'),
      toKid: z.string().optional().describe('transfer only: the kid RECEIVING'),
      source: z.string().optional().describe('which pot, e.g. "trip leftover", "USA dollars", "gifts"'),
      date: z.string().optional().describe('YYYY-MM-DD when it happened (default today)'),
      rate: z.number().positive().optional().describe('ILS per 1 unit of currency, to override the automatic rate'),
      confirmOverBudget: z.boolean().optional().describe('only after the owner explicitly OKs going over the balance'),
    }),
    execute: async ({ kid, type, amount, currency, description, toKid, source, date, rate, confirmOverBudget }) => {
      const k = ledger.resolveKid(kid)
      if (!k) return unknown(kid)
      const cur = (currency ?? 'ILS').trim().toUpperCase()
      const r = await rateFor(cur, rate)
      if (typeof r === 'string') return r
      try {
        // Over-budget gate (code, not prompt): money going OUT must fit the balance.
        if (type === 'purchase' || type === 'transfer') {
          const cost = round2(Math.abs(amount) * r)
          const bal = ledger.balance(k)
          if (cost > bal && !confirmOverBudget) {
            return `⚠️ over budget: ${k} has ${ils(bal)} but this is ${ils(cost)} (short ${ils(round2(cost - bal))}). NOT recorded. Tell the owner; only if they confirm, call again with confirmOverBudget:true.`
          }
        }
        if (type === 'transfer') {
          if (!toKid) return 'a transfer needs toKid (the kid receiving)'
          const to = ledger.resolveKid(toKid)
          if (!to) return unknown(toKid)
          const [out, inn] = ledger.transfer({ from: k, to, amount, currency: cur, rate: r, description, source, date })
          return `recorded transfer:\n${fmtEntry(out)}\n${fmtEntry(inn)}`
        }
        const e = ledger.add({ kid: k, category: type, amount, currency: cur, rate: r, description, source, date })
        const warn = e.balanceIls < 0 ? `\n⚠️ ${k} is now in the negative (${ils(e.balanceIls)}).` : ''
        return `recorded ${fmtEntry(e)}${warn}`
      } catch (e) {
        return `not recorded: ${(e as Error).message}`
      }
    },
  })
  return tools
}
