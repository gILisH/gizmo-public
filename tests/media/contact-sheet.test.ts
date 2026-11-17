import { describe, it, expect } from 'vitest'
import { Jimp } from 'jimp'
import { makeContactSheet } from '../../src/media/contact-sheet'

// A real (tiny) JPEG so Jimp.read works in the composite path.
async function jpeg(color: number): Promise<Buffer> {
  return Buffer.from(await new Jimp({ width: 64, height: 64, color }).getBuffer('image/jpeg'))
}

describe('makeContactSheet', () => {
  it('no photos → null', async () => {
    expect(await makeContactSheet([])).toBeNull()
  })
  it('one photo → returns it unchanged (no pointless tiling)', async () => {
    const only = await jpeg(0xff0000ff)
    expect(await makeContactSheet([only])).toBe(only)
  })
  it('several photos → ONE composited sheet whose dimensions tile them (not N images)', async () => {
    const sheet = await makeContactSheet([await jpeg(0xff0000ff), await jpeg(0x00ff00ff), await jpeg(0x0000ffff)])
    expect(sheet).toBeInstanceOf(Buffer)
    const img = await Jimp.read(sheet!)
    // 3 photos → 2 cols × 2 rows of 512px cells
    expect(img.bitmap.width).toBe(1024)
    expect(img.bitmap.height).toBe(1024)
  })
  it('caps at 4 cells (a 5th photo is dropped, still one 2x2 sheet)', async () => {
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => jpeg(0x888888ff)))
    const img = await Jimp.read((await makeContactSheet(five))!)
    expect(img.bitmap.width).toBe(1024)
    expect(img.bitmap.height).toBe(1024) // 2 rows, not 3
  })
})
