// Pick the photos a task needs from everything Gizmo can see for the asker: a person's
// face-library photos by name, or history photos by description (same ACL as searchHistory).
// Only the chosen photos go into the sandbox — never the whole archive.
export const MAX_PHOTOS = 20
const PER_QUERY = 6

export type Photo = { name: string; buf: Buffer }

export async function findPhotos(
  queries: string[],
  d: {
    personPhotos: (name: string) => { name: string; photos: Buffer[] } | undefined
    searchPhotos: (query: string, limit: number) => Promise<Array<{ id: string; buf: Buffer }>>
  },
): Promise<{ photos: Photo[]; missed: string[] }> {
  const photos: Photo[] = []
  const missed: string[] = []
  const seen = new Set<string>()
  const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 40) || 'photo'
  for (const q of queries) {
    if (photos.length >= MAX_PHOTOS) break
    const person = d.personPhotos(q)
    const found = person
      ? person.photos.slice(0, PER_QUERY).map((buf, i) => ({ id: `person:${person.name}:${i}`, buf }))
      : await d.searchPhotos(q, PER_QUERY)
    const fresh = found.filter((p) => !seen.has(p.id))
    if (!fresh.length) missed.push(q)
    for (const [i, p] of fresh.entries()) {
      if (photos.length >= MAX_PHOTOS) break
      seen.add(p.id)
      photos.push({ name: `${slug(person?.name ?? q)}-${i + 1}.jpg`, buf: p.buf })
    }
  }
  return { photos, missed }
}
