// Pure formatting / parsing helpers used by the brain and its tools. No deps, no I/O —
// kept out of index.ts so the brain core reads as orchestration, not string-wrangling.

import { isGroupJid } from '../access/jid'

// A tool that THROWS aborts the whole brain turn (the user gets "having trouble").
// Network tools fail routinely (dead links, timeouts, bot-walls), so wrap them: a failure
// comes back as text the model reads and works around — e.g. it can still categorize the
// other links after one URL 403s.
export async function toolResult(fn: () => Promise<string>, onError: string): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    return `${onError}: ${(e as Error).message}`
  }
}

// Home timezone. A chat that travels (e.g. "we're in Boston") overrides it per chat.
export const HOME_TZ = 'Asia/Jerusalem'

const pad = (n: number) => String(n).padStart(2, '0')

// True for a valid IANA zone name ("America/New_York").
export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// Wall-clock parts of an instant in `tz`.
function zonedParts(ms: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  )
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, weekday: p.weekday as string }
}

// Minutes `tz` is ahead of UTC at that instant (DST-aware).
function offsetMin(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000)
}

// Unix ms for a wall-clock time in `tz`. Two passes so a time near a DST switch lands right.
function zonedToMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const first = guess - offsetMin(guess, tz) * 60000
  return guess - offsetMin(first, tz) * 60000
}

// Day bounds (unix seconds) for a YYYY-MM-DD string in `tz`. Single date → that whole
// day; with `to` → inclusive range.
export function parseDayRange(from: string, to?: string, tz: string = HOME_TZ): [number, number] {
  const bounds = (d: string): [number, number] => {
    const [y, m, day] = d.split('-').map(Number)
    const start = zonedToMs(y, m, day, 0, 0, 0, tz)
    return [Math.floor(start / 1000), Math.floor(zonedToMs(y, m, day + 1, 0, 0, 0, tz) / 1000) - 1]
  }
  return [bounds(from)[0], bounds(to ?? from)[1]]
}

// Unix seconds for a model-given ISO datetime. One without an offset ("2026-11-04T09:00")
// is wall-clock time in the chat's `tz`, not the server's clock. NaN when unparseable.
export function parseWhen(iso: string, tz: string = HOME_TZ): number {
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/)
  const ms = m ? zonedToMs(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), tz) : new Date(iso).getTime()
  return Math.floor(ms / 1000)
}

// Convert Markdown the model tends to emit into WhatsApp markup (WhatsApp bold is a
// SINGLE asterisk; Markdown bold is double, which renders literally on WhatsApp).
export function toWhatsAppMarkup(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*') // **bold** -> *bold*
    .replace(/^#{1,6}\s+/gm, '') // strip markdown headers
    .replace(/\*\*/g, '') // drop any stray leftover double-asterisks
}

// One history line for the model: "[YYYY-MM-DD HH:MM · where] Name: text". Naming the
// chat (group name if known) lets pronouns resolve — a "you" in a group is between OTHER
// members, not the owner you're talking to.
export function fmtMsg(m: { ts: number; senderName?: string; chatName?: string; chatJid: string; text: string }, tz: string = HOME_TZ): string {
  const p = zonedParts(m.ts * 1000, tz)
  const day = `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`
  const where = m.chatName ? ` · ${m.chatName}` : isGroupJid(m.chatJid) ? ' · group' : ''
  return `[${day}${where}] ${m.senderName ?? 'Unknown'}: ${m.text}`
}

// The model's "now": local date AND time in the chat's timezone (it can't do tz math itself).
export function localDateLine(now: Date, tz: string = HOME_TZ): string {
  const p = zonedParts(now.getTime(), tz)
  const off = offsetMin(now.getTime(), tz)
  const utc = `UTC${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  const away = tz === HOME_TZ ? '' : ` This chat is set to ${tz} (home is ${HOME_TZ}) — "today", "tonight", "tomorrow" and opening hours are all ${tz} time. If they say they're back home, call set_timezone with "home".`
  return `Current date: ${p.y}-${pad(p.mo)}-${pad(p.d)} (${p.weekday}), local time ${pad(p.h)}:${pad(p.mi)} ${tz} (${utc}).${away} Resolve relative dates like "yesterday", "last week", "this month" against this. Dates for tools are YYYY-MM-DD; times for tools are local ${tz} time.`
}

// Human-readable age so the model never has to do date math (LLMs are bad at it).
export function ageLabel(sec: number): string {
  if (sec < 10) return 'just now'
  if (sec < 60) return `${Math.floor(sec)}s ago`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 365) return `${d}d ago`
  return `${Math.floor(d / 365)}y ago`
}

// Compact local wall-clock for a message in the chat's tz, e.g. "04 Jul, 14:32".
export function localStamp(ts: number, tz: string = HOME_TZ): string {
  return new Date(ts * 1000).toLocaleString('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
