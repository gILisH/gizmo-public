import { describe, it, expect } from 'vitest'
import { mediaFileName, msgIdOf, pickPhotoHit, makeMediaLibrary } from '../../src/media/saved-photo'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('saved-photo helpers', () => {
  it('msgIdOf strips the "<source>:" prefix', () => {
    expect(msgIdOf('personal:3EB0ABC')).toBe('3EB0ABC')
    expect(msgIdOf('dedicated:XYZ')).toBe('XYZ')
  })
  it('mediaFileName sanitizes so ids cannot escape the media dir', () => {
    expect(mediaFileName('3EB0ABC')).toBe('3EB0ABC.jpg')
    expect(mediaFileName('../../etc/passwd')).toBe('______etc_passwd.jpg')
  })
  it('takes the first hit whose bytes exist on disk (file existence, not text-sniffing)', () => {
    const hits = [
      { id: 'personal:t1', text: 'just a text message' }, // no file → skip
      { id: 'personal:i1', text: '[image] a beach sunset' }, // image, but no file → skip
      { id: 'personal:i2', text: '[image] savta with a drink' }, // has file → winner
      { id: 'personal:i3', text: '[image] another one' },
    ]
    const have = new Set(['i2', 'i3'])
    expect(pickPhotoHit(hits, (m) => have.has(m))?.id).toBe('personal:i2')
  })
  it('matches a CAPTIONED photo whose text does NOT start with [image]', () => {
    // foldCaption puts the caption first: "caption\n[image] desc" — the fix must still match it.
    const hits = [{ id: 'personal:c1', text: 'גשם מטפטף\n[image] an adult and a boy' }]
    expect(pickPhotoHit(hits, (m) => m === 'c1')?.id).toBe('personal:c1')
  })
  it('returns undefined when no hit has bytes', () => {
    const hits = [{ id: 'personal:i1', text: '[image] x' }]
    expect(pickPhotoHit(hits, () => false)).toBeUndefined()
  })
})

describe('makeMediaLibrary', () => {
  it('returns bytes only for hits it holds, in hit order', () => {
    const lib = makeMediaLibrary(join(mkdtempSync(join(tmpdir(), 'gizmo-media-')), 'media'))
    lib.persist('B', Buffer.from('bee'))
    lib.persist('C', Buffer.from('sea'))
    const hits = [{ id: 'personal:A' }, { id: 'dedicated:B' }, { id: 'personal:C' }]
    expect(lib.firstImage(hits)?.toString()).toBe('bee')
    expect(lib.images(hits, 5).map((p) => p.id)).toEqual(['B', 'C'])
    expect(lib.images(hits, 1)).toHaveLength(1)
    expect(lib.firstImage([{ id: 'personal:A' }])).toBeNull()
  })
})
