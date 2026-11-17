// The most-recent photos per chat, used as "the photo I'm working with" by edit_image,
// enroll_person, place_into_photo, set_avatar. Two guards keep photos from ONE task
// leaking into the NEXT: a TTL (a photo sent minutes ago for a different request is no
// longer "current") and a per-chat cap. Without the TTL, enrolling "Itai" grabbed
// leftover photos from an earlier "put Shira in this pic" flow and saved them as Itai.

export interface PhotoStash {
  add(chatJid: string, buf: Buffer): void
  get(chatJid: string): Buffer[] // fresh (non-expired) photos, oldest→newest
  clear(chatJid: string): void
}

export function makePhotoStash(opts: { ttlMs?: number; max?: number; now?: () => number } = {}): PhotoStash {
  const ttlMs = opts.ttlMs ?? 60_000 // 1 min: long enough to send photo then type, short enough to not bleed across tasks
  const max = opts.max ?? 4
  const now = opts.now ?? Date.now
  const m = new Map<string, { buf: Buffer; ts: number }[]>()
  return {
    add(chatJid, buf) {
      const list = (m.get(chatJid) ?? []).filter((e) => now() - e.ts < ttlMs)
      list.push({ buf, ts: now() })
      m.set(chatJid, list.slice(-max))
    },
    get(chatJid) {
      const cut = now() - ttlMs
      return (m.get(chatJid) ?? []).filter((e) => e.ts >= cut).map((e) => e.buf)
    },
    clear(chatJid) {
      m.delete(chatJid)
    },
  }
}
