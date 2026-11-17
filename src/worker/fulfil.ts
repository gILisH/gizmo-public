import { chooseEditor, type EditorName, type ImageEditor } from '../media/edit'
import { findPhotos } from './photos'
import type { GizmoRequest, Made } from './client'

// Claude Code can't make pixels; Gizmo can. This does what Claude Code asks of Gizmo's own
// tools: generate_image (Gizmo's image models, with the family's saved faces as references)
// and get_photos (the photo library). The API keys stay here — the sandbox never sees them.
export const MAX_REFS = 6
const FACES_PER_PERSON = 2

// Which enrolled people's faces the worker may pull: those Dan named (in his words or the
// photos list) in a claude_code message he approved. A grant lasts a day from the last mention
// — background work runs for hours — and a fresh conversation clears them all.
// ponytail: substring match on names; a short name ("Dan") also matches inside a longer word.
export const GRANT_TTL_MS = 24 * 3600_000
export function makePeopleGrants(o: { list: () => Array<{ id: string; names: string[] }>; resolve: (name: string) => { id: string } | undefined; now?: () => number }) {
  const now = o.now ?? Date.now
  const until = new Map<string, number>()
  return {
    grant(texts: string[]): void {
      const t = texts.join('\n').toLowerCase()
      for (const p of o.list()) if (p.names.some((n) => n.trim() && t.includes(n.trim().toLowerCase()))) until.set(p.id, now() + GRANT_TTL_MS)
    },
    clear: () => until.clear(),
    allowed: (name: string): boolean => {
      const p = o.resolve(name)
      return Boolean(p && (until.get(p.id) ?? 0) > now())
    },
  }
}

const notNamed = (names: string[]) => `Not allowed: ${names.join(', ')} — Dan didn't name them in what he asked you. Ask him to mention them to Gizmo if you need their photos.`

export function makeFulfil(o: {
  mayUse?: (name: string) => boolean // a person's saved faces only if Dan named them (makePeopleGrants)
  personPhotos: (name: string) => { name: string; photos: Buffer[] } | undefined
  searchPhotos: (chatJid: string) => (query: string, limit: number) => Promise<Array<{ id: string; buf: Buffer }>> // the chat's ACL
  editors: Partial<Record<EditorName, ImageEditor>>
  defaultEditor: () => EditorName
  generate: (prompt: string) => Promise<Buffer> // text → image (flux, then the free fallback); editors + generate carry the shared daily cap (media/cap.ts)
}) {
  return async (chatJid: string, req: GizmoRequest): Promise<Made> => {
    // An enrolled person the worker wasn't granted: refused (not searched for in history either).
    const refused = (n: string) => Boolean(o.mayUse && !o.mayUse(n) && o.personPhotos(n))
    if (req.tool === 'get_photos') {
      const queries = (req.args.queries as string[]) ?? []
      const blocked = queries.filter(refused)
      const { photos, missed } = await findPhotos(queries.filter((q) => !blocked.includes(q)), { personPhotos: o.personPhotos, searchPhotos: o.searchPhotos(chatJid) })
      const text = [missed.length ? `No photos found for: ${missed.join(', ')}` : '', blocked.length ? notNamed(blocked) : ''].filter(Boolean).join(' ')
      return { files: photos, text: text || undefined }
    }

    const { prompt, people: asked = [], references = [], engine } = req.args as { prompt: string; people?: string[]; references?: Buffer[]; engine?: EditorName }
    const blocked = asked.filter(refused)
    if (blocked.length) return { text: notNamed(blocked) }
    const people = asked
    const missing: string[] = []
    const faces = people.flatMap((n) => {
      const p = o.personPhotos(n)
      if (!p?.photos.length) missing.push(n)
      return p?.photos.slice(0, FACES_PER_PERSON) ?? []
    })
    const refs = [...references, ...faces].slice(0, MAX_REFS)
    let buf: Buffer
    let used: string
    if (refs.length) {
      const name = chooseEditor(refs.length > 1, engine, o.editors, o.defaultEditor())
      if (!name) return { text: 'No image model that can work from references is set up.' }
      buf = await o.editors[name]!(refs, prompt)
      used = name
    } else if (engine === 'gemini' && o.editors.gemini) {
      buf = await o.editors.gemini([], prompt) // nano-banana makes images from text too
      used = 'gemini'
    } else {
      buf = await o.generate(prompt)
      used = 'flux'
    }
    const notes = [`Made with ${used}${refs.length ? ` from ${refs.length} reference${refs.length > 1 ? 's' : ''}` : ''}.`]
    if (missing.length) notes.push(`No saved face photos for: ${missing.join(', ')}.`)
    return { files: [{ name: 'image.png', buf }], text: notes.join(' ') }
  }
}
