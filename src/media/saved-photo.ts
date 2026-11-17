import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Re-sending a photo Gizmo has already SEEN (in any chat/group, on either socket). On
// ingest we persist each image's bytes to disk keyed by its WhatsApp message id, alongside
// the usual `[image] <description>` text row used for search. To re-send, we semantic-search
// the text rows, then map a matching row back to its saved file. This is generic: any image
// in history can be attached to any outgoing message (a DM reply, or a staged group post).

// File name for a message's saved image. Sanitized so a weird id can't escape the media dir.
export const mediaFileName = (msgId: string) => `${msgId.replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`

// Search rows are namespaced "<source>:<msgId>"; the saved file is keyed by the bare msgId.
export const msgIdOf = (rowId: string) => rowId.slice(rowId.indexOf(':') + 1)

// From a list of search hits, pick the first whose IMAGE BYTES we actually have on disk.
// File existence is the reliable signal — ONLY image messages are persisted, so a hit with a
// saved file IS an image. (Don't sniff the text for a leading "[image]": a captioned photo's
// row is "caption\n[image] desc", so the marker isn't at the start.)
export function pickPhotoHit<T extends { id: string; text?: string }>(
  hits: T[],
  hasFile: (msgId: string) => boolean,
): T | undefined {
  return hits.find((h) => hasFile(msgIdOf(h.id)))
}

// The on-disk photo library: every image Gizmo sees, keyed by WhatsApp msg id.
export function makeMediaLibrary(dir: string) {
  mkdirSync(dir, { recursive: true })
  const path = (msgId: string) => join(dir, mediaFileName(msgId))
  const has = (msgId: string) => existsSync(path(msgId))
  return {
    persist(msgId: string, buf: Buffer): void {
      try { writeFileSync(path(msgId), buf) } catch (e) { console.error('persistImage failed:', (e as Error).message) }
    },
    // The first search hit we hold the bytes for (see pickPhotoHit), or null.
    firstImage(hits: { id: string }[]): Buffer | null {
      const hit = pickPhotoHit(hits, has)
      return hit ? readFileSync(path(msgIdOf(hit.id))) : null
    },
    // Up to `limit` search hits we hold the bytes for, in hit order.
    images(hits: { id: string }[], limit: number): { id: string; buf: Buffer }[] {
      return hits.map((h) => msgIdOf(h.id)).filter(has).slice(0, limit).map((id) => ({ id, buf: readFileSync(path(id)) }))
    },
  }
}
