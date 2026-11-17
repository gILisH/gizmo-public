import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

// A curated library of known people → reference photos, so the owner can say
// "put Itai and savta on the moon" and Gizmo pulls the right faces.
//
// Identity model: each person has a STABLE id (never derived from a mutable name, so
// renaming/aliasing never orphans their photos), a list of ALL the names they go by
// ("Ruth", "savta ruth", "mum", "סבתא" → one person), an optional relation, and an
// optional WhatsApp jid (only when the subject happens to be a contact — grandmas/kids
// usually aren't). Photos live in a folder named by the id. Resolution matches a query
// against any of the names; the BRAIN resolves relations ("his dad") via the roster.

export const REL_TYPES = ['mother', 'father', 'parent', 'child', 'spouse', 'sibling'] as const
export type RelType = (typeof REL_TYPES)[number]
// The inverse edge kept in sync automatically (X's mother is Y ⟹ Y's child is X).
const INVERSE: Record<RelType, RelType> = {
  mother: 'child', father: 'child', parent: 'child', child: 'parent', spouse: 'spouse', sibling: 'sibling',
}

export interface Person {
  id: string // stable, generated (readable-slug + short suffix); the photo folder is this
  names: string[] // every alias incl. the display name; names[0] is the primary
  relation?: string // free-text "Alex's mom" (legacy/context); structured edges live in rel
  rel?: Partial<Record<RelType, string[]>> // family graph edges → other person ids
  jid?: string // optional link to their WhatsApp contact, when known
  heightCm?: number // real height — drives relative-proportion hints in generated scenes
  count: number // number of reference photos
}

// Turn a set of people's real heights into a VISUAL proportion instruction for the image
// model. Numbers-in-prompt ("173cm") are near-noise to diffusion models; a tallest→shortest
// ordering with each person's fraction-of-the-tallest is the language they actually honor.
// Returns null when fewer than 2 of them have a known height (nothing to compare).
export function heightGuide(people: Pick<Person, 'names' | 'heightCm'>[]): string | null {
  const known = people.filter((p): p is Pick<Person, 'names'> & { heightCm: number } => typeof p.heightCm === 'number' && p.heightCm > 0)
  if (known.length < 2) return null
  const sorted = [...known].sort((a, b) => b.heightCm - a.heightCm)
  const tallest = sorted[0]!.heightCm
  const parts = sorted.map((p, i) => (i === 0 ? `${p.names[0]} (tallest)` : `${p.names[0]} (~${Math.round((p.heightCm / tallest) * 100)}% of ${sorted[0]!.names[0]}'s height)`))
  return `IMPORTANT — reproduce these RELATIVE HEIGHTS accurately, tallest to shortest: ${parts.join(', ')}. Make the size differences clearly visible; do NOT draw everyone the same height.`
}

export interface People {
  enroll(name: string, opts: { aliases?: string[]; relation?: string; jid?: string; forceNew?: boolean }, images: Buffer[]): Person
  ambiguousMatch(candidateNames: string[]): Person | undefined // existing person matched ONLY by first-word (confirm before merging), else undefined
  resolve(nameOrAlias: string): Person | undefined
  addNames(nameOrAlias: string, extra: string[]): Person | undefined // unify: "savta is also 'mum'"
  // Record "person is the <relation> of `of`" + the inverse edge. Returns both, or undefined if either name is unknown.
  setHeight(nameOrAlias: string, cm: number): Person | undefined // record real height (for scene proportions)
  setRelation(personName: string, relation: RelType, ofName: string): { person: Person; of: Person } | undefined
  list(): Person[] // photo-free roster for the system prompt
  photos(id: string): Buffer[] // reference photos, in display order (matches removePhoto positions)
  lastPhotoAt(id: string): number | undefined // mtime (ms epoch) of the newest photo, or undefined if none
  removePhoto(id: string, position: number): { remaining: number } | undefined // delete one photo by 1-based display position
  remove(nameOrAlias: string): Person | undefined
}

const norm = (s: string) => s.trim().toLowerCase()
const firstWord = (s: string) => norm(s).split(/\s+/)[0]

// A stable, readable id: unicode-safe slug of the name + a short random suffix so it's
// unique and never collides (the suffix is frozen at creation; renames don't touch it).
function makeId(name: string, taken: Set<string>): string {
  const base = norm(name).replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '') || 'person'
  let id = `${base}-${randomBytes(2).toString('hex')}`
  while (taken.has(id)) id = `${base}-${randomBytes(2).toString('hex')}`
  return id
}

interface Manifest {
  people: Person[]
}

// Upgrade a legacy entry ({slug,name,aliases}) to the current shape ({id,names[]}).
function normalize(raw: any): Person {
  if (raw.id && Array.isArray(raw.names)) return raw as Person
  const names = [raw.name, ...(raw.aliases ?? [])].map((s: string) => String(s).trim()).filter(Boolean)
  return { id: raw.slug ?? raw.id ?? 'person', names, relation: raw.relation, jid: raw.jid, heightCm: raw.heightCm, count: raw.count ?? 0 }
}

export function openPeople(rootDir: string): People {
  if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true })
  const manifestPath = join(rootDir, 'manifest.json')
  const load = (): Manifest => {
    if (!existsSync(manifestPath)) return { people: [] }
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { people: any[] }
    return { people: (m.people ?? []).map(normalize) }
  }
  const save = (m: Manifest) => writeFileSync(manifestPath, JSON.stringify(m, null, 2))
  const dirFor = (id: string) => {
    const d = join(rootDir, id)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }
  const jpgs = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort((a, b) => parseInt(a) - parseInt(b))
  // Next photo filename = max existing +1, NOT count — after a delete, count < max index,
  // so reusing count would overwrite a surviving photo.
  const nextIndex = (dir: string) => { const n = jpgs(dir).map((f) => parseInt(f)); return n.length ? Math.max(...n) + 1 : 0 }
  // Match a query against any name — exact, or the query equals the first word of a
  // name (so "שירה" resolves "שירה פרץ", "Dan" resolves "Dan Mizrahi"). First-word
  // only, to avoid matching unrelated people.
  const find = (m: Manifest, query: string): Person | undefined => {
    const q = norm(query)
    return m.people.find((p) => p.names.some((n) => norm(n) === q || firstWord(n) === q))
  }
  const findExact = (m: Manifest, query: string): Person | undefined => {
    const q = norm(query)
    return m.people.find((p) => p.names.some((n) => norm(n) === q))
  }
  const addUnique = (list: string[], extra: string[]) => {
    for (const x of extra) {
      const t = x.trim()
      if (t && !list.some((n) => norm(n) === norm(t))) list.push(t)
    }
  }

  return {
    ambiguousMatch(candidateNames) {
      // The confirm-worthy case: no name matches EXACTLY, but one matches only by first
      // word (e.g. enrolling "Omer" when a different "Omer Cohen" exists). Returns the
      // existing person to ask about; undefined when it's a clean merge (exact) or new.
      const m = load()
      if (candidateNames.some((n) => findExact(m, n))) return undefined // exact → clean merge
      return candidateNames.map((n) => find(m, n)).find(Boolean) // first-word-only → ambiguous
    },
    enroll(name, opts, images) {
      const m = load()
      const candidateNames = [name, ...(opts.aliases ?? [])]
      // Merge into an existing person if ANY provided name resolves to them — unless the
      // caller forces a new person (after the owner confirmed "someone new").
      let person = opts.forceNew ? undefined : candidateNames.map((n) => find(m, n)).find(Boolean)
      if (!person) {
        person = { id: makeId(name, new Set(m.people.map((p) => p.id))), names: [], relation: undefined, jid: undefined, count: 0 }
        m.people.push(person)
      }
      addUnique(person.names, candidateNames)
      if (opts.relation) person.relation = opts.relation.trim()
      if (opts.jid && !person.jid) person.jid = opts.jid
      const dir = dirFor(person.id)
      let idx = nextIndex(dir)
      for (const buf of images) { writeFileSync(join(dir, `${idx++}.jpg`), buf); person.count++ }
      save(m)
      return { ...person }
    },
    setHeight(nameOrAlias, cm) {
      const m = load()
      const person = find(m, nameOrAlias)
      if (!person) return undefined
      person.heightCm = cm
      save(m)
      return { ...person }
    },
    addNames(nameOrAlias, extra) {
      const m = load()
      const person = find(m, nameOrAlias)
      if (!person) return undefined
      addUnique(person.names, extra)
      save(m)
      return { ...person }
    },
    setRelation(personName, relation, ofName) {
      const m = load()
      const person = find(m, personName) // e.g. Ruth
      const of = find(m, ofName) // e.g. Dan — "Ruth is the mother of Dan"
      if (!person || of === undefined || person.id === of.id) return undefined
      const link = (a: Person, type: RelType, bId: string) => {
        a.rel ??= {}
        a.rel[type] ??= []
        if (!a.rel[type]!.includes(bId)) a.rel[type]!.push(bId)
      }
      link(of, relation, person.id) // of's <relation> is person
      link(person, INVERSE[relation], of.id) // and the inverse
      save(m)
      return { person: { ...person }, of: { ...of } }
    },
    resolve(nameOrAlias) {
      const p = find(load(), nameOrAlias)
      return p ? { ...p } : undefined
    },
    list() {
      return load().people.map((p) => ({ ...p }))
    },
    photos(id) {
      const dir = join(rootDir, id)
      if (!existsSync(dir)) return []
      return jpgs(dir).map((f) => readFileSync(join(dir, f)))
    },
    lastPhotoAt(id) {
      const dir = join(rootDir, id)
      if (!existsSync(dir)) return undefined
      const files = jpgs(dir)
      if (files.length === 0) return undefined
      return Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs))
    },
    removePhoto(id, position) {
      const m = load()
      const person = m.people.find((p) => p.id === id)
      const dir = join(rootDir, id)
      if (!person || !existsSync(dir)) return undefined
      const files = jpgs(dir)
      if (position < 1 || position > files.length) return undefined
      rmSync(join(dir, files[position - 1]))
      person.count = files.length - 1
      save(m)
      return { remaining: person.count }
    },
    remove(nameOrAlias) {
      const m = load()
      const person = find(m, nameOrAlias)
      if (!person) return undefined
      m.people = m.people.filter((p) => p.id !== person.id)
      save(m)
      rmSync(join(rootDir, person.id), { recursive: true, force: true })
      return { ...person }
    },
  }
}
