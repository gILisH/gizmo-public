import { describe, it, expect, vi, afterEach } from 'vitest'
import { grokEditImage, pickEditor } from '../../src/media/edit'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // fake png bytes

describe('grokEditImage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs the xAI edits endpoint with a base64 data-URI image + prompt', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 }),
    )
    const out = await grokEditImage(PNG, 'make it a sketch', 'xai-key')
    expect(spy.mock.calls[0][0]).toBe('https://api.x.ai/v1/images/edits')
    const req = JSON.parse((spy.mock.calls[0][1] as any).body)
    expect(req.model).toBe('grok-imagine-image-quality')
    expect(req.prompt).toBe('make it a sketch')
    expect(req.image.type).toBe('image_url')
    expect(req.image.url).toBe(`data:image/jpeg;base64,${PNG.toString('base64')}`)
    expect((spy.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer xai-key')
    expect(out.equals(PNG)).toBe(true) // decoded from b64_json
  })

  it('downloads the result when the API returns a URL instead of b64', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://img.x.ai/out.png' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(PNG, { status: 200 }))
    const out = await grokEditImage(PNG, 'x', 'k')
    expect(out.equals(PNG)).toBe(true)
  })

  it('throws a clear error on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('quota', { status: 429 }))
    await expect(grokEditImage(PNG, 'x', 'k')).rejects.toThrow(/429/)
  })
})

describe('pickEditor', () => {
  const avail = { gemini: 'G' as any, grok: 'X' as any }
  it('honors an explicit request when available', () => {
    expect(pickEditor('grok', avail, 'gemini')).toBe('grok')
  })
  it('falls back to the default when the request is unavailable', () => {
    expect(pickEditor('grok', { gemini: 'G' as any }, 'gemini')).toBe('gemini')
  })
  it('no request → the default; default missing → whatever exists', () => {
    expect(pickEditor(undefined, avail, 'gemini')).toBe('gemini')
    expect(pickEditor(undefined, { grok: 'X' as any }, 'gemini')).toBe('grok')
  })
  it('nothing available → undefined', () => {
    expect(pickEditor('grok', {}, 'gemini')).toBeUndefined()
  })
})

describe('chooseEditor — multi-image forces gemini (grok edit is single-image)', () => {
  it('single image: normal pickEditor (honors request)', async () => {
    const { chooseEditor } = await import('../../src/media/edit')
    expect(chooseEditor(false, 'grok', { gemini: 'G' as any, grok: 'X' as any })).toBe('grok')
  })
  it('multi image: gemini regardless of requested model', async () => {
    const { chooseEditor } = await import('../../src/media/edit')
    expect(chooseEditor(true, 'grok', { gemini: 'G' as any, grok: 'X' as any })).toBe('gemini')
  })
  it('multi image but no fusion editor → undefined (cannot combine on grok)', async () => {
    const { chooseEditor } = await import('../../src/media/edit')
    expect(chooseEditor(true, undefined, { grok: 'X' as any })).toBeUndefined()
  })
  it('multi image: flux is fusion-capable — used when gemini absent', async () => {
    const { chooseEditor } = await import('../../src/media/edit')
    expect(chooseEditor(true, undefined, { flux: 'F' as any, grok: 'X' as any })).toBe('flux')
  })
  it('multi image: honors an explicit fusion-capable request (flux) over the gemini fallback', async () => {
    const { chooseEditor } = await import('../../src/media/edit')
    expect(chooseEditor(true, 'flux', { gemini: 'G' as any, flux: 'F' as any })).toBe('flux')
  })
})
