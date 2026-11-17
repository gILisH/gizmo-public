import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPeople, heightGuide } from '../src/people'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gizmo-people-')) })
const img = (s: string) => Buffer.from(s)

describe('PersonStore — id-keyed, names[] model', () => {
  it('enrolls with a stable id + names[]; folder = id; photos round-trip', () => {
    const p = openPeople(root)
    const person = p.enroll('רות', { aliases: ['סבתא רות', 'סבתא'], relation: "Dan's mom" }, [img('a'), img('b')])
    expect(person.id).toMatch(/^רות-[0-9a-f]{4}$/)
    expect(person.names).toEqual(['רות', 'סבתא רות', 'סבתא'])
    expect(p.photos(person.id).length).toBe(2)
  })

  it('removePhoto deletes one by position; a later enroll does NOT overwrite a survivor', () => {
    const p = openPeople(root)
    const person = p.enroll('Itai', {}, [img('p0'), img('p1'), img('p2')]) // files 0,1,2
    expect(p.removePhoto(person.id, 2)).toEqual({ remaining: 2 }) // drop the middle (p1)
    expect(p.photos(person.id).map(String)).toEqual(['p0', 'p2']) // survivors intact
    // next enroll must NOT reuse index 2 (would clobber p2) — max+1 → 3
    p.enroll('Itai', {}, [img('p3')])
    expect(p.photos(person.id).map(String)).toEqual(['p0', 'p2', 'p3'])
    expect(p.resolve('Itai')!.count).toBe(3)
  })
  it('setHeight records real height, persists, resolves by any name; unknown → undefined', () => {
    const p = openPeople(root)
    p.enroll('אלכס', { aliases: ['Alex'] }, [img('k')])
    expect(p.setHeight('Alex', 173)!.heightCm).toBe(173)
    expect(openPeople(root).resolve('אלכס')!.heightCm).toBe(173) // persisted across reload
    expect(p.setHeight('Nobody', 150)).toBeUndefined()
  })

  it('removePhoto rejects an out-of-range position', () => {
    const p = openPeople(root)
    const person = p.enroll('X', {}, [img('a')])
    expect(p.removePhoto(person.id, 5)).toBeUndefined()
    expect(p.removePhoto(person.id, 0)).toBeUndefined()
    expect(p.photos(person.id).length).toBe(1) // untouched
  })

  it('resolves by ANY of the names (all fold to one person)', () => {
    const p = openPeople(root)
    p.enroll('Ruth', { aliases: ['savta ruth', 'mum', 'Mizrahi Ruth'] }, [img('r')])
    for (const q of ['ruth', 'savta ruth', 'mum', 'mizrahi ruth', 'Ruth']) {
      expect(p.resolve(q)?.names[0]).toBe('Ruth')
    }
  })

  it('resolves a first name against a full name; does NOT over-match', () => {
    const p = openPeople(root)
    p.enroll('שירה פרץ', {}, [img('a')])
    expect(p.resolve('שירה')?.names[0]).toBe('שירה פרץ')
    expect(p.resolve('גיא')).toBeUndefined()
  })

  it('enrolling again by an alias MERGES (no duplicate) — appends photos + names', () => {
    const p = openPeople(root)
    const first = p.enroll('Ruth', {}, [img('a')])
    const again = p.enroll('savta', { aliases: ['Ruth'] }, [img('b'), img('c')])
    expect(again.id).toBe(first.id)
    expect(p.list().length).toBe(1)
    expect(p.photos(first.id).length).toBe(3)
    expect(again.names).toEqual(expect.arrayContaining(['Ruth', 'savta']))
  })

  it('addNames unifies extra aliases onto an existing person', () => {
    const p = openPeople(root)
    const person = p.enroll('Ruth', {}, [img('a')])
    p.addNames('ruth', ['mum', 'סבתא'])
    expect(p.resolve('mum')?.id).toBe(person.id)
    expect(p.resolve('סבתא')?.id).toBe(person.id)
  })

  it('stores an optional jid link', () => {
    const p = openPeople(root)
    const person = p.enroll('Dan', { jid: '972500000100@s.whatsapp.net' }, [img('g')])
    expect(person.jid).toBe('972500000100@s.whatsapp.net')
  })

  it('remove deletes the person + photos (by any name)', () => {
    const p = openPeople(root)
    const person = p.enroll('Dan', { aliases: ['me'] }, [img('a')])
    expect(p.remove('me')?.id).toBe(person.id)
    expect(p.resolve('dan')).toBeUndefined()
    expect(existsSync(join(root, person.id))).toBe(false)
  })

  it('persists + self-migrates a LEGACY manifest ({slug,name,aliases}) on load', () => {
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify({ people: [{ slug: 'רות', name: 'רות', aliases: ['סבתא'], relation: "Dan's mom", count: 0 }] }),
    )
    const p = openPeople(root)
    const hit = p.resolve('סבתא')
    expect(hit?.id).toBe('רות')
    expect(hit?.names).toEqual(['רות', 'סבתא'])
  })

  it('list() is photo-free', () => {
    const p = openPeople(root)
    p.enroll('Ruth', {}, [img('a')])
    expect((p.list()[0] as any).photos).toBeUndefined()
  })
})

describe('family relations (structured edges + auto-inverse)', () => {
  it('setRelation records the edge and its inverse', () => {
    const p = openPeople(root)
    p.enroll('Ruth', {}, [img('r')])
    p.enroll('Dan', {}, [img('g')])
    p.setRelation('Ruth', 'mother', 'Dan') // "Ruth is the mother of Dan"
    const dan = p.resolve('Dan')!
    const ruth = p.resolve('Ruth')!
    expect(dan.rel?.mother).toEqual([ruth.id]) // Dan's mother = Ruth
    expect(ruth.rel?.child).toEqual([dan.id]) // inverse: Ruth's child = Dan
  })
  it('supports the speaker-relative case: Lia→אמא=Shira, Shira→אמא=Ruth', () => {
    const p = openPeople(root)
    p.enroll('Ruth', { aliases: ['סבתא'] }, [img('r')])
    p.enroll('Shira', {}, [img('m')])
    p.enroll('Lia', {}, [img('n')])
    p.setRelation('Shira', 'mother', 'Lia') // Lia's mother is Shira
    p.setRelation('Ruth', 'mother', 'Shira') // Shira's mother is Ruth
    const noa = p.resolve('Lia')!, michal = p.resolve('Shira')!, ruth = p.resolve('Ruth')!
    expect(noa.rel?.mother).toEqual([michal.id]) // "אמא" from Lia → Shira
    expect(michal.rel?.mother).toEqual([ruth.id]) // "אמא" from Shira → Ruth
  })
  it('returns undefined if a name is unknown', () => {
    const p = openPeople(root)
    p.enroll('Ruth', {}, [img('r')])
    expect(p.setRelation('Ruth', 'mother', 'Nobody')).toBeUndefined()
  })
})

describe('ambiguousMatch — confirm before merging on a bare first-name collision', () => {
  it('flags an existing person when a NEW name matches only by first word', () => {
    const p = openPeople(root)
    p.enroll('Omer Cohen', {}, [img('a')])
    expect(p.ambiguousMatch(['Omer'])?.names[0]).toBe('Omer Cohen') // "Omer" → ambiguous
  })
  it('does NOT flag on an exact name/alias match (clean merge)', () => {
    const p = openPeople(root)
    p.enroll('Omer Cohen', { aliases: ['Dudu'] }, [img('a')])
    expect(p.ambiguousMatch(['Omer Cohen'])).toBeUndefined()
    expect(p.ambiguousMatch(['Dudu'])).toBeUndefined()
  })
  it('does NOT flag a brand-new name (nothing to confuse)', () => {
    const p = openPeople(root)
    p.enroll('Omer Cohen', {}, [img('a')])
    expect(p.ambiguousMatch(['Sarah'])).toBeUndefined()
  })
  it('forceNew makes enroll always create a separate person', () => {
    const p = openPeople(root)
    const a = p.enroll('Omer', {}, [img('a')])
    const b = p.enroll('Omer', { forceNew: true }, [img('b')]) // "someone new, also Omer"
    expect(b.id).not.toBe(a.id)
    expect(p.list().length).toBe(2)
  })
})

describe('heightGuide', () => {
  const P = (name: string, heightCm?: number) => ({ names: [name], heightCm })
  it('null when fewer than 2 known heights', () => {
    expect(heightGuide([P('Alex', 173), P('Eden')])).toBeNull()
    expect(heightGuide([P('Alex'), P('Dan')])).toBeNull()
  })
  it('orders tallest→shortest with fraction-of-tallest for the rest', () => {
    const g = heightGuide([P('Dan', 168), P('Eden', 130), P('Alex', 173), P('Omer', 135)])!
    expect(g).toContain('tallest to shortest: Alex (tallest)')
    expect(g.indexOf('Alex')).toBeLessThan(g.indexOf('Dan')) // sorted desc
    expect(g.indexOf('Dan')).toBeLessThan(g.indexOf('Omer'))
    expect(g).toMatch(/Dan \(~97% of Alex/) // 168/173 ≈ 97%
    expect(g).toMatch(/Omer \(~78% of Alex/) // 135/173 ≈ 78%
    expect(g).toMatch(/do NOT draw everyone the same height/i)
  })
})
