import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseJid } from './jid'

// Resolve a JID (phone or @lid) to a bare phone number, or null if unknown.
export interface Resolver {
  toPhone(jid: string): string | null
}

// Static map resolver: { lidId -> phoneDigits }. Built at runtime from creds.me
// (owner) + Baileys lid-mapping files; injected as a fake in tests.
export class MapResolver implements Resolver {
  constructor(private readonly lidToPhone: Record<string, string> = {}) {}
  toPhone(jid: string): string | null {
    const { id, kind } = parseJid(jid)
    if (kind === 'pn') return id
    if (kind === 'lid') return this.lidToPhone[id] ?? null
    return null
  }
}

// Build a resolver from Baileys creds dirs: each creds.json's `me` carries the
// account's own phone id + lid, giving a reliable lid→phone entry (at least for
// the owner accounts). ponytail: other contacts' lid→phone come from the live
// Baileys lid store later; the owner (the identity that matters for full-corpus
// + Google access) is covered here.
export function loadCredsResolver(credsDirs: string[]): MapResolver {
  const map: Record<string, string> = {}
  for (const dir of credsDirs) {
    const p = join(dir, 'creds.json')
    if (!existsSync(p)) continue
    try {
      const me = (JSON.parse(readFileSync(p, 'utf8')).me ?? {}) as { id?: string; lid?: string }
      if (me.id && me.lid) map[parseJid(me.lid).id] = parseJid(me.id).id
    } catch {
      /* ignore malformed creds */
    }
  }
  return new MapResolver(map)
}

// Build a resolver from creds.me (owner self-mapping) + per-owner Baileys
// lid-mapping files (`lid-mapping-<phone>.json` → "<lid>"). Targeted reads for
// the owners only — never scans the full mapping store.
export function buildResolver(opts: {
  credsDirs: string[]
  lidMapDir?: string
  ownerPhones?: string[]
}): MapResolver {
  const map: Record<string, string> = {}
  for (const dir of opts.credsDirs) {
    const p = join(dir, 'creds.json')
    if (!existsSync(p)) continue
    try {
      const me = (JSON.parse(readFileSync(p, 'utf8')).me ?? {}) as { id?: string; lid?: string }
      if (me.id && me.lid) map[parseJid(me.lid).id] = parseJid(me.id).id
    } catch {
      /* ignore */
    }
  }
  if (opts.lidMapDir && opts.ownerPhones) {
    for (const phone of opts.ownerPhones) {
      const f = join(opts.lidMapDir, `lid-mapping-${phone}.json`)
      if (!existsSync(f)) continue
      try {
        const lid = String(JSON.parse(readFileSync(f, 'utf8'))).replace(/[^0-9]/g, '')
        if (lid) map[lid] = phone
      } catch {
        /* ignore */
      }
    }
  }
  return new MapResolver(map)
}

// The ACL scope for a requester: undefined (unrestricted — sees everything) ONLY for
// the personal-feed owner; everyone else is scoped to their own id, restricting history
// reads to chats they belong to. The security-critical exemption decision, isolated + tested.
export function scopeFor(requesterId: string, feedOwner: string): string | undefined {
  return requesterId === feedOwner ? undefined : requesterId
}

export interface AccessConfig {
  owners: string[] // bare phone digits — full corpus + Google (you + partner)
  allowlist: string[] // additional bare phone digits allowed a brain response (family)
}

export type CorpusScope = 'full' | 'own'

export function makeAccess(cfg: AccessConfig, resolver: Resolver) {
  const owners = new Set(cfg.owners)
  const allowed = new Set([...cfg.owners, ...cfg.allowlist])

  // Canonical phone for a JID; falls back to the bare lid id if unresolvable
  // (so an unknown @lid is treated as its own distinct, non-owner identity).
  const canonical = (jid: string): string => {
    const phone = resolver.toPhone(jid)
    if (phone) return phone
    return parseJid(jid).id
  }

  return {
    canonical,
    isOwner: (jid: string): boolean => owners.has(canonical(jid)),
    isAllowed: (jid: string): boolean => allowed.has(canonical(jid)),
    // Corpus read scope for a requester (used by search).
    corpusScope: (jid: string): CorpusScope => (owners.has(canonical(jid)) ? 'full' : 'own'),
    // Shared-room rule: a room answers at its LEAST-privileged member's tier.
    // All members owners -> 'owner' (full corpus ok); otherwise 'family'.
    groupTier: (memberJids: string[]): 'owner' | 'family' =>
      memberJids.every((j) => owners.has(canonical(j))) ? 'owner' : 'family',
  }
}
