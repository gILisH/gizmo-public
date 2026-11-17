export type JidKind = 'pn' | 'lid' | 'other'

// Normalize a WhatsApp JID to its bare id + kind, stripping the device suffix
// (":5") and domain. Baileys 7 delivers DMs as "<lid>:<dev>@lid" and phone
// identities as "<number>:<dev>@s.whatsapp.net".
export function parseJid(jid: string): { id: string; kind: JidKind } {
  if (typeof jid !== 'string') return { id: '', kind: 'other' } // Baileys can hand an object/undefined
  const at = jid.indexOf('@')
  const domain = at >= 0 ? jid.slice(at + 1) : ''
  let local = at >= 0 ? jid.slice(0, at) : jid
  const colon = local.indexOf(':')
  if (colon >= 0) local = local.slice(0, colon)
  const kind: JidKind = domain.includes('lid')
    ? 'lid'
    : domain === '' || domain.includes('s.whatsapp.net')
      ? 'pn'
      : 'other'
  return { id: local, kind }
}

// A group chat (vs a 1:1 DM).
export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us')
