import { chooseEditor, type EditorName, type ImageEditor } from './edit'
import { makeContactSheet } from './contact-sheet'
import type { PhotoStash } from './photo-stash'
import { heightGuide, type People, type Person, type RelType } from '../people'

// The image + face-library brain tools, extracted from the composition root so they're
// unit-testable with fakes. Everything they touch is injected; nothing here reaches out
// to a socket or the network directly.
export interface PeopleImageToolDeps {
  people: People
  peopleFor?: (chatJid: string) => People // the library a scene draws from in this chat (a guest group has its own); default `people`
  imageEditors: Partial<Record<EditorName, ImageEditor>>
  lastImageByChat: PhotoStash // most-recent (non-expired) photos per chat, stashed by the media pass
  sendImage: (chatJid: string, image: Buffer, caption?: string) => Promise<void>
  findJidByName: (name: string) => string | undefined // link an enrolled person to a WhatsApp contact
  imageModel: () => EditorName // current default editor (owner-switchable); multi-image work needs gemini or flux
  keepFace?: (image: Buffer, instruction: string) => Promise<Buffer> // face-lock inpaint (detect→mask→FLUX.1 Fill); present only when BFL + vision keys exist
}

// ONE reference image per person, but each is a CONTACT SHEET (a grid of that person's
// photos) — more identity signal read as a single subject, without the "3 photos → 3
// people" duplication. `firstIndex` = the image number the first reference gets.
async function referenceSheets(people: People, names: string[], firstIndex: number) {
  const missing: string[] = []
  const refs: Buffer[] = []
  const roster: string[] = []
  const chosen: Person[] = []
  for (const n of names) {
    const p = people.resolve(n)
    if (!p) { missing.push(n); continue }
    const sheet = await makeContactSheet(people.photos(p.id))
    if (!sheet) continue
    refs.push(sheet)
    chosen.push(p)
    roster.push(`Reference image ${firstIndex + refs.length - 1} = ${p.names[0]} (ONE person, shown from several angles in a grid)`)
  }
  return { missing, refs, roster, chosen }
}

export function makePeopleImageTools(d: PeopleImageToolDeps) {
  const { people, imageEditors, lastImageByChat } = d
  const hasEditor = Object.keys(imageEditors).length > 0
  const libFor = (chatJid: string) => d.peopleFor?.(chatJid) ?? people

  return {
    // Edit the most recent photo (img2img). photos>1 = combine mode (all recent → gemini).
    editImage: hasEditor
      ? async (chatJid: string, instruction: string, model?: EditorName, photos = 1): Promise<string> => {
          const stash = lastImageByChat.get(chatJid) ?? []
          if (stash.length === 0) return 'no recent photo in this chat — ask them to send the photo first'
          const imgs = photos > 1 ? stash : stash.slice(-1)
          const multi = imgs.length > 1
          const first = chooseEditor(multi, model ?? d.imageModel(), imageEditors)
          if (!first) return multi ? 'combining photos needs the gemini editor (not configured)' : 'no image editor configured'
          try {
            await d.sendImage(chatJid, await imageEditors[first]!(imgs, instruction))
            return `edited and sent (${first})`
          } catch (err) {
            const other = multi ? undefined : (Object.keys(imageEditors) as EditorName[]).find((n) => n !== first)
            if (!other) throw err
            console.error(`${first} image edit failed, trying ${other}:`, (err as Error).message)
            await d.sendImage(chatJid, await imageEditors[other]!(imgs, instruction))
            return `edited and sent (${other})`
          }
        }
      : undefined,

    // Face-lock edit: keep the face 100% identical, regenerate the rest per the instruction.
    editKeepFace: d.keepFace
      ? async (chatJid: string, instruction: string): Promise<string> => {
          const stash = lastImageByChat.get(chatJid) ?? []
          if (stash.length === 0) return 'no recent photo in this chat — ask them to send the photo first'
          try {
            await d.sendImage(chatJid, await d.keepFace!(stash[stash.length - 1]!, instruction))
            return 'edited and sent (face locked)'
          } catch (err) {
            return `couldn't do the face-locked edit: ${(err as Error).message}`
          }
        }
      : undefined,

    // Save the recently-sent photo(s) as a known person (merges by name; confirms on a
    // bare first-name collision; auto-links a matching WhatsApp contact).
    enrollPerson: async (chatJid: string, name: string, opts: { aliases?: string[]; relation?: string; forceNew?: boolean }): Promise<string> => {
      const imgs = lastImageByChat.get(chatJid) ?? []
      if (imgs.length === 0) {
        // A label ("this is Yoav") and its photo arrive as SEPARATE WhatsApp messages,
        // firing two brain runs. One enrolls with the photo and clears the stash; the
        // sibling run lands here with nothing. If a photo for this person was written
        // seconds ago, that sibling just saved them — confirm consistently, never
        // "couldn't save". (mtime, not mere existence: an OLD save means they really
        // forgot to attach a photo, so still prompt for one.)
        const existing = people.resolve(name)
        const savedAt = existing && people.lastPhotoAt(existing.id)
        if (existing && savedAt && Date.now() - savedAt < 15_000) {
          return `already saved ${existing.names[0]} — ${existing.count} photo${existing.count === 1 ? '' : 's'} total 📸`
        }
        return 'no recent photo — send a photo of them first, then tell me who they are'
      }
      if (!opts.forceNew) {
        const amb = people.ambiguousMatch([name, ...(opts.aliases ?? [])])
        if (amb) return `I already have "${amb.names[0]}" saved. Same person (I'll add these photos), or someone new? If new, tell me and I'll save them separately.`
      }
      const jid = [name, ...(opts.aliases ?? [])].map((n) => d.findJidByName(n)).find(Boolean)
      const merged = !opts.forceNew && !!people.resolve(name)
      const p = people.enroll(name, { ...opts, jid: jid ?? undefined }, imgs)
      lastImageByChat.clear(chatJid) // consumed
      return `${merged ? 'added to' : 'saved'} ${p.names[0]} — ${p.count} photo${p.count === 1 ? '' : 's'} total${p.relation ? ` (${p.relation})` : ''} 📸`
    },

    // Generate a NEW scene placing known people into it (per-person cap so nobody is starved).
    composeScene: hasEditor
      ? async (chatJid: string, names: string[], scene: string): Promise<string> => {
          const { missing, refs, roster, chosen } = await referenceSheets(libFor(chatJid), names, 1)
          if (missing.length) return `I don't have photos of: ${missing.join(', ')} — send me some and tell me who they are first`
          if (refs.length === 0) return 'no reference photos found for those people'
          const guide = heightGuide(chosen)
          const prompt = `Create a single photorealistic image. Scene: ${scene}.\nThe final image MUST contain EXACTLY ${refs.length} ${refs.length === 1 ? 'person' : 'people'} in total — do NOT invent, add, or duplicate any extra people, children, or bystanders; ${refs.length} humans, no more, no fewer. Each reference image is ONE person (a grid showing the SAME person from multiple angles — do NOT read a grid as multiple people); put each person into the scene EXACTLY ONCE:\n${roster.join('\n')}\nReproduce each person's real face faithfully from their reference grid, keep them clearly recognizable and distinct, and compose them together naturally.${guide ? `\n${guide}` : ''}`
          // Multi-person = fusion → gemini only; single person can honor the chosen editor.
          const editor = chooseEditor(refs.length > 1, d.imageModel(), imageEditors)
          if (!editor) return refs.length > 1 ? 'multi-person scenes need the gemini editor (not configured)' : 'no image editor configured'
          try {
            await d.sendImage(chatJid, await imageEditors[editor]!(refs, prompt))
            return 'created and sent'
          } catch (err) {
            return `couldn't create the scene: ${(err as Error).message}`
          }
        }
      : undefined,

    // Add known people INTO an existing chat photo (base image + reference faces).
    placeIntoPhoto: hasEditor
      ? async (chatJid: string, names: string[], instruction: string): Promise<string> => {
          // Base + people = fusion → an editor that can combine photos (gemini or flux).
          const editor = chooseEditor(true, d.imageModel(), imageEditors)
          if (!editor) return 'this needs an image editor that can combine photos — gemini or flux (not configured)'
          const base = lastImageByChat.get(chatJid) ?? []
          if (base.length === 0) return 'send me the photo you want to add them to first'
          const baseImg = base[base.length - 1]! // the single photo to add people INTO (image 1)
          const { missing, refs, roster, chosen } = await referenceSheets(libFor(chatJid), names, 2) // image 1 is the base
          if (missing.length) return `I don't have photos of: ${missing.join(', ')} — save them first`
          if (refs.length === 0) return 'no reference photos found for those people'
          const images = [baseImg, ...refs].slice(0, 8)
          const guide = heightGuide(chosen)
          const prompt = `Image 1 is the BASE photo — keep its existing people, background, and composition UNCHANGED. Then ADD exactly ${refs.length} new ${refs.length === 1 ? 'person' : 'people'} into it: ${instruction}. Each remaining reference image is ONE person (a grid of the SAME person from several angles — do NOT read a grid as multiple people); add each EXACTLY ONCE, never duplicated:\n${roster.join('\n')}\nReproduce each added person's real face faithfully from their reference grid, keep them distinct, and leave everyone already in the base photo unchanged.${guide ? `\n${guide}` : ''}`
          try {
            await d.sendImage(chatJid, await imageEditors[editor]!(images, prompt))
            return 'created and sent'
          } catch (err) {
            return `couldn't place them into the photo: ${(err as Error).message}`
          }
        }
      : undefined,

    // Send back every saved photo of a person, numbered, so the owner can curate them.
    showPersonPhotos: async (chatJid: string, name: string): Promise<string> => {
      const p = people.resolve(name)
      if (!p) return `I don't have anyone matching "${name}" saved`
      const imgs = people.photos(p.id)
      if (imgs.length === 0) return `${p.names[0]} has no photos saved`
      for (let i = 0; i < imgs.length; i++) await d.sendImage(chatJid, imgs[i], `${p.names[0]} — ${i + 1}/${imgs.length}`)
      return `sent ${imgs.length} photo${imgs.length === 1 ? '' : 's'} of ${p.names[0]}, numbered 1–${imgs.length}. Tell me which to delete (e.g. "delete 2").`
    },
    // Delete one photo by its shown position (1-based).
    deletePersonPhoto: (name: string, position: number): string => {
      const p = people.resolve(name)
      if (!p) return `I don't have anyone matching "${name}" saved`
      const r = people.removePhoto(p.id, position)
      if (!r) return `${p.names[0]} doesn't have a photo #${position} — show the photos again and pick a valid number`
      return `deleted photo #${position} — ${p.names[0]} has ${r.remaining} photo${r.remaining === 1 ? '' : 's'} left 🗑️`
    },

    forgetPerson: (name: string): string => {
      const removed = people.remove(name)
      return removed ? `deleted ${removed.names[0]} and their ${removed.count} photo${removed.count === 1 ? '' : 's'} 🗑️` : `I don't have anyone named "${name}" saved`
    },
    addPersonNames: (name: string, extra: string[]): string => {
      const p = people.addNames(name, extra)
      return p ? `got it — ${p.names[0]} is also known as ${extra.join(', ')}` : `I don't have anyone matching "${name}" saved`
    },
    setPersonRelation: (person: string, relation: RelType, of: string): string => {
      const r = people.setRelation(person, relation, of)
      return r ? `noted — ${r.person.names[0]} is the ${relation} of ${r.of.names[0]}` : `I need both people saved first — couldn't find "${person}" and/or "${of}"`
    },
    setPersonHeight: (name: string, cm: number): string => {
      const p = people.setHeight(name, cm)
      return p ? `saved — ${p.names[0]} is ${cm}cm (I'll keep proportions right in scenes)` : `I don't have anyone matching "${name}" saved`
    },
    listPeople: () => people.list(),
  }
}
