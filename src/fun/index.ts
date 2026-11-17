// Memes via memegen.link (free, no key) + GIFs via Tenor (free key).

// memegen path-escaping: _ → __, - → --, space → _, plus ~-codes for specials.
export function memegenEscape(s: string): string {
  const escaped = s
    .replace(/_/g, '__')
    .replace(/-/g, '--')
    .replace(/ /g, '_')
    .replace(/\?/g, '~q')
    .replace(/&/g, '~a')
    .replace(/%/g, '~p')
    .replace(/#/g, '~h')
    .replace(/\//g, '~s')
    .replace(/\n/g, '~n')
    .replace(/"/g, "''")
  return escaped.length ? escaped : '_'
}

// Emoji never render on memegen's caption fonts — they come out as tofu boxes.
// Strip them (+ variation selectors / ZWJ) before building the URL.
const stripEmoji = (s: string) =>
  s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/gu, '').replace(/\s{2,}/g, ' ').trim()

const hasHebrew = (s: string) => /[֐-׿]/.test(s)

export function memeUrl(template: string, top: string, bottom: string): string {
  const t = stripEmoji(top)
  const b = stripEmoji(bottom)
  const seg = (s: string) => encodeURIComponent(memegenEscape(s)) // encode Hebrew/unicode, keep _ and ~
  // Default Impact font has no Hebrew glyphs → switch to a Hebrew-capable font when needed.
  const font = hasHebrew(t) || hasHebrew(b) ? '?font=notosanshebrew' : ''
  return `https://api.memegen.link/images/${encodeURIComponent(template)}/${seg(t)}/${seg(b)}.png${font}`
}

export async function fetchMeme(template: string, top: string, bottom: string): Promise<Buffer> {
  const res = await fetch(memeUrl(template, top, bottom))
  if (!res.ok) throw new Error(`memegen ${res.status} for template "${template}"`)
  return Buffer.from(await res.arrayBuffer())
}

// Giphy GIF search → MP4 bytes (WhatsApp "GIFs" are MP4 + gifPlayback).
// (Tenor's API was sunset June 2026; Giphy is the live alternative.)
export async function fetchGif(query: string): Promise<Buffer> {
  const key = process.env.GIPHY_API_KEY
  if (!key) throw new Error('GIPHY_API_KEY not set')
  const url = `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(query)}&limit=10&rating=pg-13`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`giphy ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const data = (await res.json()) as {
    data?: { images?: { original_mp4?: { mp4?: string }; original?: { mp4?: string } } }[]
  }
  const withMp4 = (data.data ?? []).filter((g) => g.images?.original_mp4?.mp4 ?? g.images?.original?.mp4)
  if (withMp4.length === 0) throw new Error(`no gif found for "${query}"`)
  const pick = withMp4[Math.floor(Math.random() * withMp4.length)] // variety
  const mp4 = pick.images?.original_mp4?.mp4 ?? pick.images?.original?.mp4
  const gif = await fetch(mp4!)
  if (!gif.ok) throw new Error(`giphy mp4 download ${gif.status}`)
  return Buffer.from(await gif.arrayBuffer())
}

// AI image generation via Pollinations (free, no key). Gemini's image models have
// zero free-tier quota, so this is the free path for text→image + avatars.
export async function fetchAiImage(prompt: string, seed = Math.floor(Math.random() * 1e9)): Promise<Buffer> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`pollinations ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1000) throw new Error('pollinations returned an empty image')
  return buf
}
