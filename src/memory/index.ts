import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Episode {
  at: number
  text: string
}

export interface Memory {
  addFact(id: string, fact: string): void
  loadFacts(id: string): string
  addGroupFact(chatJid: string, fact: string): void // append one shared fact
  loadGroupFacts(chatJid: string): string
  writeGroupFacts(chatJid: string, facts: string[]): void // replace the whole list (correction); backs up prior
  loadGroupFactsBackup(chatJid: string): string // the pre-correction version, for recovery
  recordEpisode(id: string, ep: Episode): void
  recentEpisodes(id: string, limit: number): Episode[]
  injectContext(soul: string, id: string, groupChatJid?: string): string
}

// Per-speaker memory: facts.md (semantic) + recent.jsonl (episodic), namespaced
// by hash(canonicalId). The id is ALWAYS an explicit parameter — there is no
// ambient/global "current speaker" state to leak across users (the strongest
// form of the speaker-scoping guarantee: you cannot read/write memory without
// naming whose it is). Single Node process + sync fs writes ⇒ no per-identity
// lock needed (no concurrent writers). ponytail: add flock only if it ever runs
// multi-process.
export function openMemory(rootDir: string): Memory {
  const dirFor = (id: string): string => {
    const h = createHash('sha256').update(id).digest('hex').slice(0, 16)
    const d = join(rootDir, h)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }
  const factsPath = (id: string) => join(dirFor(id), 'facts.md')
  const epPath = (id: string) => join(dirFor(id), 'recent.jsonl')
  // Group facts live under a prefixed key so they can never collide with a person's.
  const groupKey = (chatJid: string) => `grp:${chatJid}`

  const loadFacts = (id: string): string =>
    existsSync(factsPath(id)) ? readFileSync(factsPath(id), 'utf8') : ''

  const recentEpisodes = (id: string, limit: number): Episode[] => {
    if (!existsSync(epPath(id))) return []
    const lines = readFileSync(epPath(id), 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => JSON.parse(l) as Episode)
  }

  return {
    addFact(id, fact) {
      appendFileSync(factsPath(id), `- ${fact.trim()}\n`)
    },
    loadFacts,
    addGroupFact(chatJid, fact) {
      appendFileSync(factsPath(groupKey(chatJid)), `- ${fact.trim()}\n`)
    },
    loadGroupFacts(chatJid) {
      return loadFacts(groupKey(chatJid))
    },
    writeGroupFacts(chatJid, facts) {
      const p = factsPath(groupKey(chatJid))
      if (existsSync(p)) copyFileSync(p, `${p}.prev`) // one-level undo before overwriting
      writeFileSync(p, facts.map((f) => `- ${f.trim()}`).join('\n') + '\n')
    },
    loadGroupFactsBackup(chatJid) {
      const bak = `${factsPath(groupKey(chatJid))}.prev`
      return existsSync(bak) ? readFileSync(bak, 'utf8') : ''
    },
    recordEpisode(id, ep) {
      appendFileSync(epPath(id), JSON.stringify(ep) + '\n')
    },
    recentEpisodes,
    injectContext(soul, id, groupChatJid) {
      const facts = loadFacts(id).trim()
      const eps = recentEpisodes(id, 10)
      const parts = [soul, '', '## What you know about this person', facts || '(nothing saved yet)']
      if (groupChatJid) {
        const gf = loadFacts(groupKey(groupChatJid)).trim() // shared family knowledge, in a group
        if (gf) parts.push('', '## What you know about this family/group', gf)
      }
      if (eps.length) {
        parts.push('', '## Recent context', ...eps.map((e) => `- ${e.text}`))
      }
      return parts.join('\n')
    },
  }
}
