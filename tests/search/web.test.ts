import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import { formatResults, webSearchFromEnv, jinaFetch, webFetchFromEnv, fetchWebMedia, makeSendWebMedia, pinnedGet } from '../../src/search/web'

describe('formatResults', () => {
  it('leads with the synthesized answer, then compact sources', () => {
    const out = formatResults('Tel Aviv is ~28°C.', [
      { title: 'Weather TLV', url: 'https://ex.com/w', content: 'Sunny, 28 degrees, light wind.' },
    ])
    expect(out).toContain('Answer: Tel Aviv is ~28°C.')
    expect(out).toContain('Weather TLV (https://ex.com/w)')
  })
  it('handles no answer / no results', () => {
    expect(formatResults(undefined, [])).toBe('no results')
    expect(formatResults(undefined, [{ title: 'T', url: 'u', content: 'c' }])).toContain('Sources:')
  })
})

describe('webSearchFromEnv', () => {
  it('is null without a key, a fn with one', () => {
    const saved = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    expect(webSearchFromEnv()).toBeNull()
    process.env.TAVILY_API_KEY = 'tvly-test'
    expect(typeof webSearchFromEnv()).toBe('function')
    if (saved === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = saved
  })
})

describe('jinaFetch (browser-rendered page reader)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('routes the URL through r.jina.ai and returns the rendered text', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('# Title\n\nrendered body text', { status: 200 }),
    )
    const out = await jinaFetch('https://example.com/article?x=1')
    expect(spy.mock.calls[0][0]).toBe('https://r.jina.ai/https://example.com/article?x=1')
    expect(out).toContain('rendered body text')
  })

  it('sends the API key as a Bearer header when provided', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    await jinaFetch('https://example.com', 'jina-key-123')
    expect((spy.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer jina-key-123')
  })

  it('caps very long pages so they do not blow the context', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(50_000), { status: 200 }))
    const out = await jinaFetch('https://example.com')
    expect(out.length).toBeLessThanOrEqual(12_050) // ~12k cap + short truncation marker
    expect(out).toContain('[truncated]')
  })

  it('throws a clear error on a non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }))
    await expect(jinaFetch('https://blocked.example')).rejects.toThrow(/403/)
  })
})

describe('webFetchFromEnv', () => {
  it('always returns a fn (Jina needs no key)', () => {
    expect(typeof webFetchFromEnv()).toBe('function')
  })
})

describe('formatResults images', () => {
  it('lists image URLs so the model can send real photos', () => {
    expect(formatResults(undefined, [], ['https://cdn.ex.com/a.jpg'])).toContain('Images:\n- https://cdn.ex.com/a.jpg')
  })
})

describe('fetchWebMedia (guarded download)', () => {
  const pub = async () => [{ address: '93.184.216.34', family: 4 }]
  const res = (status: number, headers: Record<string, string> = {}, body = '') => ({
    status,
    header: (n: string) => headers[n.toLowerCase()],
    bytes: async () => Buffer.from(body),
  })

  it('downloads a public image with its mimetype + file name', async () => {
    const get = vi.fn(async () => res(200, { 'content-type': 'image/jpeg; x=1' }, 'JPG'))
    const m = await fetchWebMedia('https://ex.com/pics/hotel%201.jpg', pub, get)
    expect(m).toEqual({ bytes: Buffer.from('JPG'), mimetype: 'image/jpeg', fileName: 'hotel 1.jpg' })
  })

  it.each([
    ['127.0.0.1', 4], ['10.1.2.3', 4], ['100.64.0.1', 4], ['169.254.169.254', 4], ['172.18.0.5', 4], ['::1', 6], ['::ffff:192.168.1.1', 6], ['fd7a:115c::1', 6],
  ])('refuses private address %s (tailnet/metadata/loopback/compose)', async (address, family) => {
    const get = vi.fn()
    await expect(fetchWebMedia('http://evil.ex.com/x.jpg', async () => [{ address, family }], get)).rejects.toThrow('private')
    expect(get).not.toHaveBeenCalled()
  })

  it('DNS rebinding: resolves once and connects to the VETTED address, never a second answer', async () => {
    let n = 0
    const rebinding = async () => [{ address: n++ === 0 ? '93.184.216.34' : '172.18.0.5', family: 4 }]
    const get = vi.fn(async () => res(200, { 'content-type': 'image/png' }, 'P'))
    await fetchWebMedia('http://rebind.ex/x.png', rebinding, get)
    expect(n).toBe(1)
    expect(get).toHaveBeenCalledTimes(1)
    expect((get.mock.calls[0] as any)[1]).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('re-vets and re-pins every redirect hop', async () => {
    const get = vi.fn(async () => res(302, { location: 'http://internal.ex/' }))
    const resolve = async (h: string) => [{ address: h === 'internal.ex' ? '127.0.0.1' : '93.184.216.34', family: 4 }]
    await expect(fetchWebMedia('https://ex.com/x.jpg', resolve, get)).rejects.toThrow('private')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('refuses non-http schemes', async () => {
    await expect(fetchWebMedia('file:///etc/passwd', pub)).rejects.toThrow('http')
  })
})

describe('pinnedGet', () => {
  it('connects to the pinned IP regardless of what the hostname would resolve to', async () => {
    const server = http.createServer((req, r) => r.end(`host=${req.headers.host}`))
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const port = (server.address() as any).port
    try {
      const r = await pinnedGet(new URL(`http://does-not-exist.invalid:${port}/x`), { address: '127.0.0.1', family: 4 }, {})
      expect(r.status).toBe(200)
      expect((await r.bytes()).toString()).toBe(`host=does-not-exist.invalid:${port}`)
    } finally {
      server.close()
    }
  })
})

describe('makeSendWebMedia', () => {
  const media = (mimetype: string) => async () => ({ bytes: Buffer.from('B'), mimetype, fileName: 'f.x' })
  const sender = () => ({ sendImage: vi.fn(async () => {}), sendDocument: vi.fn(async () => {}) })

  it('sends jpeg/png as a photo as-is', async () => {
    const s = sender()
    await makeSendWebMedia(s, media('image/png'))('c@s.whatsapp.net', 'u', 'Hotel A')
    expect(s.sendImage).toHaveBeenCalledWith('c@s.whatsapp.net', Buffer.from('B'), 'Hotel A')
  })

  it('converts webp/avif to jpeg before sending', async () => {
    const s = sender()
    await makeSendWebMedia(s, media('image/webp'), async () => Buffer.from('J'))('c', 'u')
    expect(s.sendImage).toHaveBeenCalledWith('c', Buffer.from('J'), undefined)
  })

  it('sends non-images as documents and refuses web pages', async () => {
    const s = sender()
    await makeSendWebMedia(s, media('application/pdf'))('c', 'u')
    expect(s.sendDocument).toHaveBeenCalledWith('c', Buffer.from('B'), 'f.x', 'application/pdf', undefined)
    await expect(makeSendWebMedia(s, media('text/html'))('c', 'u')).rejects.toThrow('web page')
  })
})
