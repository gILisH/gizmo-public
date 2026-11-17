// Actions held until the owner approves, keyed by the chat they're talking in: cross-chat
// sends (post_to_group → confirm_send) and, in a second instance, injectable actions
// (claude_code / schedule_task → confirm_action). Each carries the turn that staged it: a
// confirm from that same turn is refused (the model can't approve its own action), and so
// is a confirm with no turn id (a scheduled task's replay, which no human typed).
export function makePostStager() {
  const pending = new Map<string, { targetName: string; run: () => Promise<string | void>; turnId: string }>()
  return {
    stage(fromChat: string, targetName: string, run: () => Promise<string | void>, turnId: string): void {
      pending.set(fromChat, { targetName, run, turnId })
    },
    async confirm(fromChat: string, turnId: string): Promise<string> {
      const p = pending.get(fromChat)
      if (!p) return 'nothing staged to send'
      if (!turnId || p.turnId === turnId) return `not done: "${p.targetName}" was staged in this same turn. Ask the owner and wait for their reply; confirm only after they approve.`
      pending.delete(fromChat)
      try {
        return (await p.run()) || `sent to "${p.targetName}"`
      } catch (e) {
        // Report the real failure instead of throwing — a thrown confirm makes the model
        // re-stage and loop. This is a FINAL outcome: tell the owner why, do NOT retry.
        return `couldn't send to "${p.targetName}": ${(e as Error).message}. Don't retry — tell the owner this plainly.`
      }
    },
    cancel(fromChat: string): string {
      return pending.delete(fromChat) ? 'canceled the staged send' : 'nothing was staged'
    },
  }
}

export interface NamedGroup {
  jid: string
  name: string
  members?: number
}

// "Familia (…4821, 5 members)" — the jid tail tells apart same-named groups (anyone can
// create a group called "Familia" and add Gizmo), so the owner can see which one it is.
export function groupLabel(g: NamedGroup): string {
  const tail = g.jid.split('@')[0].slice(-4)
  return `${g.name} (…${tail}${g.members ? `, ${g.members} members` : ''})`
}

// Resolve a group by (fuzzy) name → its jid. Callers pass only TRUSTED candidates (family/
// allowed groups when configured). An exact name beats a substring match so "Familia"
// doesn't pick "Familia Extended"; more than one match at the winning tier THROWS with the
// options listed — never guess between lookalikes. No name → the fallback.
export function resolveGroup(name: string | undefined, groups: NamedGroup[], fallback?: string): string | undefined {
  if (!name?.trim()) return fallback
  const q = name.trim().toLowerCase()
  const exact = groups.filter((g) => g.name.toLowerCase() === q)
  const hits = exact.length
    ? exact
    : groups.filter((g) => {
        const n = g.name.toLowerCase()
        return n.includes(q) || q.includes(n)
      })
  if (hits.length > 1) throw new Error(`"${name}" matches more than one group: ${hits.map(groupLabel).join('; ')}. Ask the owner which one.`)
  return hits[0]?.jid
}

// Only these groups may be targets: family + allowed groups when either is configured,
// else every group Gizmo is in (an unconfigured box — nothing to narrow by).
export function trustedGroups(groups: string[], cfg: { familyGroups: string[]; allowedGroups: string[] }): string[] {
  const trusted = new Set([...cfg.familyGroups, ...cfg.allowedGroups])
  return trusted.size ? groups.filter((g) => trusted.has(g)) : groups
}

// The household group = the owners' PRIVATE group (e.g. Dan + Alex + Gizmo), resolved by
// MEMBERSHIP: the SMALLEST group that contains all owners. NOT the most-active group —
// that's usually the big family group, a different chat. With no such group, fall back to
// the first FAMILY group only — never an arbitrary group someone added Gizmo to.
export function pickHouseholdGroup(
  groups: string[],
  membersOf: (jid: string) => string[],
  owners: string[],
  familyGroups: string[] = [],
): string | undefined {
  const containsAllOwners = groups
    .map((jid) => ({ jid, size: membersOf(jid).length, ok: owners.every((o) => membersOf(jid).includes(o)) }))
    .filter((x) => x.ok)
    .sort((a, b) => a.size - b.size)
  return containsAllOwners[0]?.jid ?? groups.find((g) => familyGroups.includes(g))
}
