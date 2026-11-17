// Parse a phone-exported vCard (.vcf) into { name, phones } so we can resolve
// message senders to the names the OWNER actually uses ("Asia", "Mom") — WhatsApp
// only hands a companion a partial address book, so this is the complete source.

export interface VCardContact {
  name: string
  phones: string[] // normalized to E.164 digits (no '+'), matching WhatsApp JIDs
}

// Normalize a raw phone to the digits WhatsApp uses in JIDs (E.164, no '+').
// Israeli local "05x…" → "9725x…"; keeps already-international numbers as-is.
export function normalizePhone(raw: string, defaultCc = '972'): string | null {
  let d = raw.replace(/[^\d+]/g, '')
  if (d.startsWith('+')) d = d.slice(1)
  else if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = defaultCc + d.slice(1) // local → international
  d = d.replace(/\D/g, '')
  return d.length >= 7 && d.length <= 15 ? d : null // sanity bounds
}

// Parse vCard text (one or many cards). Handles line folding and the common
// FN/N + TEL properties across vCard 2.1/3.0/4.0.
export function parseVCards(text: string, defaultCc = '972'): VCardContact[] {
  // Unfold: continuation lines start with a space/tab.
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const out: VCardContact[] = []
  let name = ''
  let fallbackName = ''
  let phones: string[] = []
  for (const line of lines) {
    const upper = line.toUpperCase()
    if (upper.startsWith('BEGIN:VCARD')) {
      name = ''
      fallbackName = ''
      phones = []
    } else if (upper.startsWith('END:VCARD')) {
      const n = name || fallbackName
      const uniq = [...new Set(phones)]
      if (n && uniq.length) out.push({ name: n, phones: uniq })
    } else if (upper.startsWith('FN')) {
      name = line.slice(line.indexOf(':') + 1).trim()
    } else if (upper.startsWith('N:') || upper.startsWith('N;')) {
      // N: Last;First;… → "First Last" as a fallback if no FN
      const parts = line.slice(line.indexOf(':') + 1).split(';').map((s) => s.trim())
      fallbackName = [parts[1], parts[0]].filter(Boolean).join(' ').trim()
    } else if (upper.startsWith('TEL')) {
      const p = normalizePhone(line.slice(line.indexOf(':') + 1), defaultCc)
      if (p) phones.push(p)
    }
  }
  return out
}
