import { describe, it, expect } from 'vitest'
import { bflRun, bflImageFields } from '../../src/media/bfl'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })

// A scripted fetch: returns queued responses in order, recording calls.
function scriptedFetch(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init })
    return responses.shift() ?? new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
  return { fn, calls }
}
const noSleep = async () => {}

describe('bflRun (async submit → poll → download)', () => {
  it('submits with x-key, polls until Ready, downloads result.sample', async () => {
    const { fn, calls } = scriptedFetch([
      json({ id: 'x', polling_url: 'https://poll/1' }), // submit
      json({ status: 'Pending' }), // poll 1
      json({ status: 'Ready', result: { sample: 'https://delivery/out.png' } }), // poll 2
      new Response(PNG, { status: 200 }), // download
    ])
    const out = await bflRun('flux-2-pro', { prompt: 'hi' }, 'bfl-key', { fetch: fn, sleep: noSleep })
    expect(out.equals(PNG)).toBe(true)
    expect(calls[0].url).toBe('https://api.bfl.ai/v1/flux-2-pro')
    expect((calls[0].init!.headers as any)['x-key']).toBe('bfl-key')
    expect(JSON.parse(calls[0].init!.body as string).prompt).toBe('hi')
    expect(calls[1].url).toBe('https://poll/1') // polled the returned url
    expect(calls[3].url).toBe('https://delivery/out.png') // downloaded the sample
  })

  it('throws on a failed generation', async () => {
    const { fn } = scriptedFetch([json({ polling_url: 'https://poll/1' }), json({ status: 'Error' })])
    await expect(bflRun('m', {}, 'k', { fetch: fn, sleep: noSleep })).rejects.toThrow(/Error/)
  })

  it('throws a clear error on a non-200 submit', async () => {
    const { fn } = scriptedFetch([new Response('bad key', { status: 401 })])
    await expect(bflRun('m', {}, 'k', { fetch: fn, sleep: noSleep })).rejects.toThrow(/401/)
  })

  it('times out if never Ready (deadline passed before polling)', async () => {
    const { fn } = scriptedFetch([json({ polling_url: 'https://poll/1' })]) // submit ok, no poll reached
    await expect(bflRun('m', {}, 'k', { fetch: fn, sleep: noSleep, timeoutMs: -1 })).rejects.toThrow(/timed out/)
  })
})

describe('bflImageFields', () => {
  it('names refs input_image, input_image_2, … as raw base64', () => {
    const f = bflImageFields([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')])
    expect(f.input_image).toBe(Buffer.from('a').toString('base64'))
    expect(f.input_image_2).toBe(Buffer.from('b').toString('base64'))
    expect(f.input_image_3).toBe(Buffer.from('c').toString('base64'))
    expect(f.input_image_1).toBeUndefined() // first is 'input_image', not 'input_image_1'
  })
})
