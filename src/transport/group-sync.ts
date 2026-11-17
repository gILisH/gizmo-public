import type { WASocket } from 'baileys'

// Group name (subject) + membership sync, shared by both transports.
export interface GroupSyncHandlers {
  onNames?: (names: { jid: string; name: string }[]) => void
  onMembers?: (chatJid: string, members: string[], mode: 'set' | 'add' | 'remove') => void
}

// Participants arrive as bare jid strings OR objects ({id,…}) depending on Baileys
// version + LID addressing. Normalize both, drop anything without a string id — else a
// non-string reaches parseJid and crashes membership capture.
export const toMemberIds = (participants: any): string[] =>
  (Array.isArray(participants) ? participants : [])
    .map((p: any) => (typeof p === 'string' ? p : p?.id))
    .filter((x: any): x is string => typeof x === 'string' && x.length > 0)

const participantIds = (g: any): string[] => toMemberIds(g?.participants)

// One-time full sync on connect: names + complete membership for every group.
export async function syncAllGroups(sock: WASocket, h: GroupSyncHandlers, label: string): Promise<void> {
  try {
    const groups = await sock.groupFetchAllParticipating()
    const names: { jid: string; name: string }[] = []
    for (const g of Object.values(groups) as any[]) {
      if (g.id && g.subject) names.push({ jid: g.id, name: g.subject })
      const ids = participantIds(g)
      if (g.id && ids.length) h.onMembers?.(g.id, ids, 'set')
    }
    if (names.length) h.onNames?.(names)
  } catch (err) {
    console.error(`group sync failed (${label}):`, (err as Error).message)
  }
}

// Live updates: participants added/removed, and newly-joined groups.
export function wireGroupEvents(sock: WASocket, h: GroupSyncHandlers): void {
  sock.ev.on('group-participants.update', ({ id, participants, action }: any) => {
    if (!id) return
    const ids = toMemberIds(participants) // normalize: live event may carry objects, not strings
    if (!ids.length) return
    if (action === 'add') h.onMembers?.(id, ids, 'add')
    else if (action === 'remove') h.onMembers?.(id, ids, 'remove')
  })
  sock.ev.on('groups.upsert', (groups: any[]) => {
    for (const g of groups ?? []) {
      if (g.id && g.subject) h.onNames?.([{ jid: g.id, name: g.subject }])
      const ids = participantIds(g)
      if (g.id && ids.length) h.onMembers?.(g.id, ids, 'set')
    }
  })
}
