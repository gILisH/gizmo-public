// Access policy — the two security decisions for who Gizmo answers and what it may
// search. Pure functions so the boundary is unit-tested, not buried in the app wiring.

// In a GROUP: answer any member, but only when addressed (@-mention/reply). In a DM:
// owners only — family can use Gizmo inside a shared group, never privately.
export function mayRespond(a: { isGroup: boolean; mentionsMe: boolean; isOwner: boolean; groupAllowed: boolean }): boolean {
  // Group: must be addressed AND in an allowed group. DM: owners only (allowlist N/A).
  return a.isGroup ? a.mentionsMe && a.groupAllowed : a.isOwner
}

// The Claude-subscription brain runs on the feed owner's personal plan: his own DMs, and
// the (already allowed + addressed) FAMILY groups he's in. Nobody else's private DM, and no
// guest group, ever uses it — guests would drain his plan at 0 counted tokens.
export function maySubscribe(a: { isGroup: boolean; guest?: boolean; isFeedOwner: boolean }): boolean {
  return a.isGroup ? !a.guest : a.isFeedOwner
}

// A group not listed as family (e.g. a work group) is a guest group: nobody there is
// treated as an owner — the owner included — and no family/personal context is loaded.
// Fail-closed: with no family groups configured, every group is a guest group.
export function isGuestGroup(a: { isGroup: boolean; chatJid: string; familyGroups: string[] }): boolean {
  return a.isGroup && !a.familyGroups.includes(a.chatJid)
}

// Full-corpus search is granted ONLY to the feed owner in their private DM. Everyone
// else — and the owner himself once inside any group — is scoped to that one chat, so a
// shared group can never surface another chat's history. Returns the chat to restrict
// to, or undefined for unrestricted.
export function searchScope(a: { isFeedOwner: boolean; isGroup: boolean; chatJid: string }): string | undefined {
  return a.isFeedOwner && !a.isGroup ? undefined : a.chatJid
}
