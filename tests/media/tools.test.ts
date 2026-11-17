import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPeople } from '../../src/people'
import { makePeopleImageTools } from '../../src/media/tools'
import { makePhotoStash } from '../../src/media/photo-stash'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gizmo-tools-')) })
const img = (s: string) => Buffer.from(s)
const CHAT = '111@s.whatsapp.net'

// Build the tools with fakes; capture what the editor + sendImage receive.
function setup(opts: { withEditor?: boolean; withGrok?: boolean; withFlux?: boolean; editorThrows?: 'gemini' | 'grok' | 'all'; findJid?: (n: string) => string | undefined; imageModel?: 'gemini' | 'grok' | 'flux'; withKeepFace?: boolean } = {}) {
  const people = openPeople(root)
  const lastImageByChat = makePhotoStash()
  const put = (chat: string, imgs: Buffer[]) => { lastImageByChat.clear(chat); for (const b of imgs) lastImageByChat.add(chat, b) }
  const sent: Buffer[] = []
  const editorCalls: Record<string, { imgs: Buffer[]; instr: string }[]> = { gemini: [], grok: [], flux: [] }
  const mkEditor = (name: 'gemini' | 'grok' | 'flux') => async (imgs: Buffer[], instr: string) => {
    editorCalls[name].push({ imgs, instr })
    if (opts.editorThrows === name || opts.editorThrows === 'all') throw new Error(`${name} boom`)
    return img(`OUT-${name}`)
  }
  const imageEditors: any = {}
  if (opts.withEditor !== false) imageEditors.gemini = mkEditor('gemini')
  if (opts.withGrok) imageEditors.grok = mkEditor('grok')
  if (opts.withFlux) imageEditors.flux = mkEditor('flux')
  const keepFaceCalls: { image: Buffer; instruction: string }[] = []
  const tools = makePeopleImageTools({
    people, imageEditors, lastImageByChat,
    sendImage: async (_j, image) => { sent.push(image) },
    findJidByName: opts.findJid ?? (() => undefined),
    imageModel: () => opts.imageModel ?? 'gemini',
    keepFace: opts.withKeepFace
      ? async (image, instruction) => { keepFaceCalls.push({ image, instruction }); return img('FACELOCKED') }
      : undefined,
  })
  return { people, lastImageByChat, put, sent, editorCalls, keepFaceCalls, tools }
}

describe('editImage', () => {
  it('no recent photo → asks to send one', async () => {
    const { tools } = setup()
    expect(await tools.editImage!(CHAT, 'sketch it')).toMatch(/no recent photo/)
  })
  it('single edit uses only the most recent photo and sends', async () => {
    const { tools, put, lastImageByChat, editorCalls, sent } = setup()
    put(CHAT, [img('old'), img('new')])
    const r = await tools.editImage!(CHAT, 'make it a sketch')
    expect(r).toBe('edited and sent (gemini)')
    expect(editorCalls.gemini[0].imgs.map(String)).toEqual(['new']) // last only, not 'old'
    expect(sent.length).toBe(1)
  })
  it('combine mode (photos=2) passes ALL recent photos', async () => {
    const { tools, put, lastImageByChat, editorCalls } = setup()
    put(CHAT, [img('a'), img('b'), img('c')])
    await tools.editImage!(CHAT, 'merge', undefined, 2)
    expect(editorCalls.gemini[0].imgs.length).toBe(3)
  })
  it('falls back to the other editor on a single-edit failure', async () => {
    const { tools, put, lastImageByChat, editorCalls } = setup({ withGrok: true, editorThrows: 'gemini' })
    put(CHAT, [img('x')])
    const r = await tools.editImage!(CHAT, 'edit', 'gemini')
    expect(r).toBe('edited and sent (grok)')
    expect(editorCalls.grok.length).toBe(1)
  })
  it('is undefined when no editor is configured', () => {
    expect(setup({ withEditor: false }).tools.editImage).toBeUndefined()
  })
})

describe('enrollPerson', () => {
  it('no recent photo → prompts for one', async () => {
    const { tools } = setup()
    expect(await tools.enrollPerson(CHAT, 'Ruth', {})).toMatch(/no recent photo/)
  })
  it('saves, consumes the stash, and auto-links a matching contact', async () => {
    const { tools, put, lastImageByChat, people } = setup({ findJid: (n) => (n.toLowerCase() === 'ruth' ? '972@s.whatsapp.net' : undefined) })
    put(CHAT, [img('a'), img('b')])
    const r = await tools.enrollPerson(CHAT, 'Ruth', { relation: "Dan's mom" })
    expect(r).toMatch(/saved Ruth/)
    expect(lastImageByChat.get(CHAT)).toHaveLength(0) // consumed
    expect(people.resolve('Ruth')!.jid).toBe('972@s.whatsapp.net') // auto-linked
    expect(people.photos(people.resolve('Ruth')!.id).length).toBe(2)
  })
  it('empty stash but person saved SECONDS ago → consistent "already saved" (double-run guard)', async () => {
    const { tools, put, people } = setup()
    put(CHAT, [img('a')])
    await tools.enrollPerson(CHAT, 'Yoav', {}) // sibling run enrolls + clears stash
    const r = await tools.enrollPerson(CHAT, 'Yoav', {}) // this run: empty stash, photo just written
    expect(r).toMatch(/already saved Yoav — 1 photo total/)
    expect(people.resolve('Yoav')!.count).toBe(1) // NOT double-counted
  })
  it('empty stash + person saved LONG ago → still prompts for a photo (not a double-run)', async () => {
    const { tools, put, people } = setup()
    put(CHAT, [img('a')])
    await tools.enrollPerson(CHAT, 'Yoav', {})
    // backdate the saved photo 1 min → this is a genuine "add another" with no attachment
    const dir = join(root, people.resolve('Yoav')!.id)
    const old = new Date(Date.now() - 60_000)
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old)
    expect(await tools.enrollPerson(CHAT, 'Yoav', {})).toMatch(/no recent photo/)
  })
  it('confirms (does NOT enroll) on a bare first-name collision', async () => {
    const { tools, put, lastImageByChat, people } = setup()
    put(CHAT, [img('a')])
    await tools.enrollPerson(CHAT, 'Omer Cohen', {})
    put(CHAT, [img('b')])
    const r = await tools.enrollPerson(CHAT, 'Omer', {}) // ambiguous
    expect(r).toMatch(/already have "Omer Cohen"/)
    expect(people.list().length).toBe(1) // not enrolled
    expect(lastImageByChat.get(CHAT)).toHaveLength(1) // stash kept for the follow-up
  })
  it('forceNew creates a separate person despite the name clash', async () => {
    const { tools, put, lastImageByChat, people } = setup()
    put(CHAT, [img('a')])
    await tools.enrollPerson(CHAT, 'Omer', {})
    put(CHAT, [img('b')])
    await tools.enrollPerson(CHAT, 'Omer', { forceNew: true })
    expect(people.list().length).toBe(2)
  })
})

describe('composeScene', () => {
  it('sends exactly ONE reference per person (a contact sheet), never one image per photo', async () => {
    const { tools, people, editorCalls } = setup()
    people.enroll('A', {}, [img('a1'), img('a2'), img('a3')]) // 3 photos → ONE sheet
    people.enroll('B', {}, [img('b1')]) // 1 photo → passthrough
    const r = await tools.composeScene!(CHAT, ['A', 'B'], 'on the moon')
    expect(r).toBe('created and sent')
    const imgs = editorCalls.gemini[0].imgs
    expect(imgs.length).toBe(2) // one ref per PERSON, not one per photo (would be 4)
    expect(String(imgs[1])).toBe('b1') // single-photo person → the photo itself
  })
  it('reports people it has no photos of', async () => {
    const { tools, put, people } = setup()
    people.enroll('A', {}, [img('a')])
    expect(await tools.composeScene!(CHAT, ['A', 'Nobody'], 'x')).toMatch(/don't have photos of: Nobody/)
  })
  it('honors the active image model for a SINGLE person, but forces gemini for multi-person', async () => {
    const single = setup({ withGrok: true, imageModel: 'grok' })
    single.people.enroll('A', {}, [img('a')])
    await single.tools.composeScene!(CHAT, ['A'], 'solo')
    expect(single.editorCalls.grok.length).toBe(1) // 1 person → grok honored
    expect(single.editorCalls.gemini.length).toBe(0)

    const multi = setup({ withGrok: true, imageModel: 'grok' })
    multi.people.enroll('A', {}, [img('a')]); multi.people.enroll('B', {}, [img('b')])
    await multi.tools.composeScene!(CHAT, ['A', 'B'], 'together')
    expect(multi.editorCalls.gemini.length).toBe(1) // 2 people (fusion) → gemini forced despite grok default
    expect(multi.editorCalls.grok.length).toBe(0)
  })
  it('prompt: each ref is ONE person (a grid), include exactly N once, never duplicated', async () => {
    const { tools, people, editorCalls } = setup()
    people.enroll('Alex', {}, [img('k1')])
    people.enroll('Dan', {}, [img('g1')])
    await tools.composeScene!(CHAT, ['Alex', 'Dan'], 'at the beach')
    const prompt = editorCalls.gemini[0].instr
    expect(prompt).toContain('EXACTLY 2 people')
    expect(prompt).toContain('= Alex (ONE person')
    expect(prompt).toContain('= Dan (ONE person')
    expect(prompt).toMatch(/do NOT read a grid as multiple people/i)
    expect(prompt).toMatch(/duplicat/i) // count guard: no duplicated/extra people
    expect(prompt).toMatch(/no extra|extra people|bystanders/i) // don't invent fillers
  })
  it('injects the relative-height guide when heights are set (≥2)', async () => {
    const { tools, people, editorCalls } = setup()
    people.enroll('Alex', {}, [img('k')]); people.setHeight('Alex', 173)
    people.enroll('Omer', {}, [img('d')]); people.setHeight('Omer', 135)
    await tools.composeScene!(CHAT, ['Alex', 'Omer'], 'on the beach')
    const prompt = editorCalls.gemini[0].instr
    expect(prompt).toMatch(/RELATIVE HEIGHTS/)
    expect(prompt).toMatch(/Alex \(tallest\)/)
    expect(prompt).toMatch(/Omer \(~78% of Alex/)
  })
  it('omits the height guide when fewer than 2 heights are known', async () => {
    const { tools, people, editorCalls } = setup()
    people.enroll('A', {}, [img('a')]); people.setHeight('A', 180)
    people.enroll('B', {}, [img('b')]) // no height
    await tools.composeScene!(CHAT, ['A', 'B'], 'x')
    expect(editorCalls.gemini[0].instr).not.toMatch(/RELATIVE HEIGHTS/)
  })
})

describe('setPersonHeight', () => {
  it('saves height and confirms; unknown person handled', () => {
    const { tools, people } = setup()
    people.enroll('Alex', {}, [img('k')])
    expect(tools.setPersonHeight('Alex', 173)).toMatch(/Alex is 173cm/)
    expect(people.resolve('Alex')!.heightCm).toBe(173)
    expect(tools.setPersonHeight('Ghost', 150)).toMatch(/don't have anyone/)
  })
})

describe('placeIntoPhoto', () => {
  it('needs a base photo in the chat', async () => {
    const { tools, put, people } = setup()
    people.enroll('Ruth', {}, [img('r')])
    expect(await tools.placeIntoPhoto!(CHAT, ['Ruth'], 'add her')).toMatch(/send me the photo/)
  })
  it('puts the base photo FIRST, then ONE reference per person', async () => {
    const { tools, put, people, editorCalls } = setup()
    people.enroll('Ruth', {}, [img('rina1')]) // 1 photo → passthrough ref
    put(CHAT, [img('BASE')])
    const r = await tools.placeIntoPhoto!(CHAT, ['Ruth'], 'add her next to the kids')
    expect(r).toBe('created and sent')
    const imgs = editorCalls.gemini[0].imgs
    expect(String(imgs[0])).toBe('BASE') // base leads
    expect(imgs.length).toBe(2) // base + one ref (not one per photo)
    expect(String(imgs[1])).toBe('rina1')
  })
  it('uses flux when that is the chosen editor (not only gemini)', async () => {
    const { tools, put, people, editorCalls } = setup({ withFlux: true, imageModel: 'flux' })
    people.enroll('Ruth', {}, [img('rina1')])
    put(CHAT, [img('BASE')])
    expect(await tools.placeIntoPhoto!(CHAT, ['Ruth'], 'add her')).toBe('created and sent')
    expect(editorCalls.flux).toHaveLength(1)
    expect(editorCalls.gemini).toHaveLength(0)
  })
  it('works with flux alone (no gemini key)', async () => {
    const { tools, put, people, editorCalls } = setup({ withEditor: false, withFlux: true })
    people.enroll('Ruth', {}, [img('rina1')])
    put(CHAT, [img('BASE')])
    expect(await tools.placeIntoPhoto!(CHAT, ['Ruth'], 'add her')).toBe('created and sent')
    expect(editorCalls.flux).toHaveLength(1)
  })
})

describe('editKeepFace', () => {
  it('undefined when keepFace dep absent', () => {
    expect(setup().tools.editKeepFace).toBeUndefined()
  })
  it('locks the face on the most recent photo and sends the result', async () => {
    const { tools, put, sent, keepFaceCalls } = setup({ withKeepFace: true })
    put(CHAT, [img('old'), img('recent')])
    const r = await tools.editKeepFace!(CHAT, 'put me in a tuxedo')
    expect(r).toMatch(/face locked/)
    expect(keepFaceCalls[0].image.toString()).toBe('recent') // most recent only
    expect(keepFaceCalls[0].instruction).toBe('put me in a tuxedo')
    expect(sent.map(String)).toEqual(['FACELOCKED'])
  })
  it('no recent photo → asks for one', async () => {
    const { tools } = setup({ withKeepFace: true })
    expect(await tools.editKeepFace!(CHAT, 'x')).toMatch(/no recent photo/)
  })
})

describe('show / delete photos', () => {
  it('showPersonPhotos sends each photo numbered', async () => {
    const { tools, people, sent } = setup()
    people.enroll('Itai', {}, [img('a'), img('b'), img('c')])
    const r = await tools.showPersonPhotos(CHAT, 'Itai')
    expect(sent.map(String)).toEqual(['a', 'b', 'c']) // all sent, in order
    expect(r).toMatch(/sent 3 photos of Itai, numbered 1–3/)
  })
  it('showPersonPhotos handles unknown person + empty library', async () => {
    const { tools, people } = setup()
    expect(await tools.showPersonPhotos(CHAT, 'Ghost')).toMatch(/don't have anyone/)
    people.enroll('Itai', {}, [img('a')])
    people.removePhoto(people.resolve('Itai')!.id, 1)
    expect(await tools.showPersonPhotos(CHAT, 'Itai')).toMatch(/no photos saved/)
  })
  it('deletePersonPhoto removes by shown number; bad number is reported', () => {
    const { tools, people } = setup()
    people.enroll('Itai', {}, [img('a'), img('b')])
    expect(tools.deletePersonPhoto('Itai', 1)).toMatch(/deleted photo #1 — Itai has 1 photo left/)
    expect(tools.deletePersonPhoto('Itai', 9)).toMatch(/doesn't have a photo #9/)
    expect(tools.deletePersonPhoto('Ghost', 1)).toMatch(/don't have anyone/)
  })
})

describe('forget / addNames / setRelation', () => {
  it('forgetPerson deletes and reports; not-found is handled', async () => {
    const { tools, put, people } = setup()
    people.enroll('Ruth', {}, [img('r')])
    expect(await tools.forgetPerson('Ruth')).toMatch(/deleted Ruth/)
    expect(await tools.forgetPerson('Ghost')).toMatch(/don't have anyone/)
  })
  it('setPersonRelation records the edge; needs both saved', async () => {
    const { tools, put, people } = setup()
    people.enroll('Ruth', {}, [img('r')])
    people.enroll('Dan', {}, [img('g')])
    expect(await tools.setPersonRelation('Ruth', 'mother', 'Dan')).toMatch(/Ruth is the mother of Dan/)
    expect(await tools.setPersonRelation('Ruth', 'mother', 'Ghost')).toMatch(/need both people saved/)
  })
  it('addPersonNames unifies aliases', async () => {
    const { tools, put, people } = setup()
    people.enroll('Ruth', {}, [img('r')])
    expect(await tools.addPersonNames('Ruth', ['mum', 'סבתא'])).toMatch(/also known as/)
    expect(people.resolve('mum')?.names[0]).toBe('Ruth')
  })
})

describe('peopleFor (guest group library)', () => {
  it('a scene in a guest group draws only on that group\'s faces, never the family library', async () => {
    const family = openPeople(join(root, 'family'))
    const group = openPeople(join(root, 'group'))
    family.enroll('Ruth', {}, [img('FAMILY-FACE')])
    group.enroll('Ofir', {}, [img('ofir')])
    const editorCalls: Buffer[][] = []
    const tools = makePeopleImageTools({
      people: family,
      peopleFor: (jid) => (jid === 'trip@g.us' ? group : family),
      imageEditors: { gemini: async (imgs: Buffer[]) => { editorCalls.push(imgs); return img('OUT') } },
      lastImageByChat: makePhotoStash(),
      sendImage: async () => {},
      findJidByName: () => undefined,
      imageModel: () => 'gemini',
    })
    expect(await tools.composeScene!('trip@g.us', ['Ruth'], 'x')).toMatch(/don't have photos of: Ruth/)
    expect(await tools.composeScene!('trip@g.us', ['Ofir'], 'x')).toBe('created and sent')
    expect(String(editorCalls[0][0])).toBe('ofir')
  })
})
