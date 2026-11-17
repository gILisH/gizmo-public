import { BlockList } from 'node:net'
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { run as ffmpeg } from '../voice/tts'

// Web search via Tavily (free tier: 1000/mo, no card). LLM-optimized — returns a
// short synthesized answer + top sources, so we feed the model clean text, not HTML.
// Provider-agnostic: a plain function tool, so it works under any brain (Gemini/Claude).

export interface WebResult {
  title: string
  url: string
  content: string
}

// Returns a formatted block for the model: the synthesized answer (if any) + sources.
export async function tavilySearch(query: string, apiKey: string, maxResults = 5): Promise<string> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: true, // Tavily's synthesized answer — usually enough on its own
      include_images: true, // image URLs, so the model can send real photos (send_web_image)
      search_depth: 'basic',
    }),
  })
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const data = (await res.json()) as { answer?: string; results?: WebResult[]; images?: string[] }
  return formatResults(data.answer, data.results ?? [], data.images ?? [])
}

export function formatResults(answer: string | undefined, results: WebResult[], images: string[] = []): string {
  const parts: string[] = []
  if (answer?.trim()) parts.push(`Answer: ${answer.trim()}`)
  if (results.length) {
    parts.push(
      'Sources:\n' +
        results.map((r) => `- ${r.title} (${r.url})\n  ${r.content.slice(0, 300)}`).join('\n'),
    )
  }
  if (images.length) parts.push('Images:\n' + images.map((u) => `- ${u}`).join('\n'))
  return parts.join('\n\n') || 'no results'
}

// Build the search fn from env, or null if unconfigured.
export function webSearchFromEnv(): ((query: string) => Promise<string>) | null {
  const key = process.env.TAVILY_API_KEY
  if (!key) return null
  return (query: string) => tavilySearch(query, key)
}

const FETCH_CAP = 12_000 // chars — enough of a page for the model, without blowing context

// Read a full page via Jina Reader (https://r.jina.ai) — a hosted headless browser that
// renders JS and returns clean markdown, so JS-walled / soft-blocked sites a plain fetch
// can't read still come back as text. Free; an optional key raises rate limits.
export async function jinaFetch(url: string, apiKey?: string): Promise<string> {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(`https://r.jina.ai/${url}`, { headers })
  if (!res.ok) throw new Error(`jina reader ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const text = await res.text()
  return text.length > FETCH_CAP ? text.slice(0, FETCH_CAP) + '\n…[truncated]' : text
}

// web_fetch is always available — Jina needs no key (JINA_API_KEY only raises limits).
export function webFetchFromEnv(): (url: string) => Promise<string> {
  const key = process.env.JINA_API_KEY || undefined
  return (url: string) => jinaFetch(url, key)
}

const MEDIA_CAP = 15 * 1024 * 1024 // bytes — WhatsApp's own image limit is ~16MB

// Block loopback/private/link-local/CGNAT (tailnet!) targets: the URL comes from the model,
// which may have read it off a web page, so it must not reach the box's own services.
const privateNets = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const)
  privateNets.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]] as const) privateNets.addSubnet(net, bits, 'ipv6')

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>
const dnsLookup: Lookup = (host) => lookup(host, { all: true })

type Addr = { address: string; family: number }

// Resolve ONCE and vet every address; the connection is then pinned to the returned one, so
// a rebinding host can't answer public here and private on a second lookup.
async function vettedAddress(url: URL, resolve: Lookup): Promise<Addr> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) links')
  const addrs = await resolve(url.hostname.replace(/^\[|\]$/g, ''))
  if (!addrs.length) throw new Error("couldn't resolve that link")
  for (const { address, family } of addrs) {
    const v4 = address.replace(/^::ffff:/, '') // IPv4-mapped IPv6
    const blocked = v4 !== address || family === 4 ? privateNets.check(v4, 'ipv4') : privateNets.check(address, 'ipv6')
    if (blocked) throw new Error('that link points at a private address')
  }
  return addrs[0]
}

export interface PinnedResponse {
  status: number
  header: (name: string) => string | undefined
  bytes: () => Promise<Buffer> // capped at MEDIA_CAP
}
export type PinnedGet = (url: URL, addr: Addr, headers: Record<string, string>) => Promise<PinnedResponse>

// GET `url` but connect to `addr` — the custom `lookup` replaces DNS, so no second resolution
// happens. Host header + TLS SNI/cert check still use the URL's hostname.
export const pinnedGet: PinnedGet = (url, { address, family }, headers) =>
  new Promise((ok, fail) => {
    const lookup = (_h: string, o: { all?: boolean }, cb: (...a: any[]) => void) =>
      o.all ? cb(null, [{ address, family }]) : cb(null, address, family)
    const req = (url.protocol === 'https:' ? https : http).get(url, { headers, timeout: 20_000, lookup: lookup as any }, (res) =>
      ok({
        status: res.statusCode ?? 0,
        header: (n) => {
          const v = res.headers[n.toLowerCase()]
          return Array.isArray(v) ? v[0] : v
        },
        bytes: () =>
          new Promise((done, err) => {
            const chunks: Buffer[] = []
            let size = 0
            res.on('data', (c: Buffer) => {
              size += c.length
              if (size > MEDIA_CAP) {
                res.destroy()
                err(new Error('file too big to send'))
              } else chunks.push(c)
            })
            res.on('end', () => done(Buffer.concat(chunks)))
            res.on('error', err)
          }),
      }),
    )
    req.on('timeout', () => req.destroy(new Error('download timed out')))
    req.on('error', fail)
  })

// Download a file (photo, PDF…) from a public URL. Redirects are followed by hand so each
// hop is re-vetted and re-pinned. No webp/avif in Accept: many CDNs then serve a JPEG
// WhatsApp can show; anything else is converted by the caller.
export async function fetchWebMedia(
  rawUrl: string,
  resolve: Lookup = dnsLookup,
  get: PinnedGet = pinnedGet,
): Promise<{ bytes: Buffer; mimetype: string; fileName: string }> {
  let url = new URL(rawUrl)
  for (let hop = 0; hop < 5; hop++) {
    const addr = await vettedAddress(url, resolve)
    const res = await get(url, addr, { accept: 'image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; Gizmo)' })
    const next = res.header('location')
    if (res.status >= 300 && res.status < 400 && next) {
      void res.bytes().catch(() => {}) // drain so the socket closes
      url = new URL(next, url)
      continue
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`download failed (${res.status})`)
    if (Number(res.header('content-length') ?? 0) > MEDIA_CAP) throw new Error('file too big to send')
    const bytes = await res.bytes()
    const mimetype = (res.header('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
    const fileName = decodeURIComponent(url.pathname.split('/').pop() || 'file')
    return { bytes, mimetype, fileName }
  }
  throw new Error('too many redirects')
}

type Media = Awaited<ReturnType<typeof fetchWebMedia>>
interface MediaSender {
  sendImage: (chatJid: string, image: Buffer, caption?: string) => Promise<void>
  sendDocument: (chatJid: string, file: Buffer, fileName: string, mimetype: string, caption?: string) => Promise<void>
}

// WhatsApp only renders JPEG/PNG photos; webp/avif/gif → first frame as JPEG.
const toJpeg = async (b: Buffer) => (await ffmpeg(['-i', 'pipe:0', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], b)).out

// Download a URL and send the REAL thing: images as photos, anything else as a document.
export function makeSendWebMedia(send: MediaSender, download: (url: string) => Promise<Media> = (u) => fetchWebMedia(u), jpeg = toJpeg) {
  return async (chatJid: string, url: string, caption?: string): Promise<string> => {
    const { bytes, mimetype, fileName } = await download(url)
    if (mimetype === 'text/html') throw new Error('that link is a web page, not a file — web_fetch it and use an image URL from inside')
    if (mimetype.startsWith('image/')) {
      await send.sendImage(chatJid, mimetype === 'image/jpeg' || mimetype === 'image/png' ? bytes : await jpeg(bytes), caption)
      return 'sent the photo'
    }
    await send.sendDocument(chatJid, bytes, fileName, mimetype, caption)
    return `sent ${fileName}`
  }
}
