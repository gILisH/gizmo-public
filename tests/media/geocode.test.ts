import { describe, it, expect } from 'vitest'
import { geocode } from '../../src/media/geocode'

const fakeFetch = (body: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, json: async () => body })) as unknown as typeof fetch

describe('geocode', () => {
  it('parses the first Nominatim hit into lat/lng/label', async () => {
    const f = fakeFetch([{ lat: '7.8804', lon: '98.3923', display_name: 'Capybara Cafe, Phuket, Thailand' }])
    expect(await geocode('capybara cafe phuket', f)).toEqual({ lat: 7.8804, lng: 98.3923, label: 'Capybara Cafe, Phuket, Thailand' })
  })
  it('no results → null', async () => {
    expect(await geocode('asdkjhaskdjh', fakeFetch([]))).toBeNull()
  })
  it('non-ok response → null (never throws)', async () => {
    expect(await geocode('x', fakeFetch([], false))).toBeNull()
  })
  it('network throw → null (never throws)', async () => {
    const f = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await geocode('x', f)).toBeNull()
  })
})
