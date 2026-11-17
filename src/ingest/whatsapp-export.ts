import type { StoredMessage } from '../store/types'

// iOS:     [12/03/2022, 14:23:01] Sender: body
// Android: 12/03/2022, 14:24 - Sender: body
const IOS_HEADER = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s+([^:]+):\s?(.*)$/
const AND_HEADER = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+-\s+([^:]+):\s?(.*)$/

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function toTs(d: string, mo: string, y: string, h: string, mi: string, se?: string): number {
  const year = y.length === 2 ? 2000 + Number(y) : Number(y)
  // WhatsApp exports are D/M/Y in most locales; treat as local time.
  return Math.floor(
    new Date(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se ?? 0)).getTime() / 1000,
  )
}

interface Draft { sender: string; ts: number; lines: string[] }

export function parseExport(text: string, chatJid: string): StoredMessage[] {
  const out: StoredMessage[] = []
  let cur: Draft | null = null

  const flush = () => {
    if (!cur) return
    const body = cur.lines.join('\n')
    out.push({
      id: `export:${chatJid}:${cur.ts}:${djb2(cur.sender + body)}`,
      chatJid,
      senderJid: `export:${cur.sender}`,
      senderName: cur.sender,
      text: body,
      ts: cur.ts,
      fromMe: false,
      source: 'export',
    })
    cur = null
  }

  for (const raw of text.split(/\r?\n/)) {
    const m = IOS_HEADER.exec(raw) ?? AND_HEADER.exec(raw)
    if (m) {
      const [, d, mo, y, h, mi, se, sender, body] = m
      flush()
      cur = { sender: sender.trim(), ts: toTs(d, mo, y, h, mi, se), lines: [body] }
    } else if (cur) {
      cur.lines.push(raw) // continuation line
    }
    // a line before any header with no match is dropped (export preamble)
  }
  flush()
  return out
}
