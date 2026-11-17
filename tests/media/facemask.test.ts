import { describe, it, expect } from 'vitest'
import { Jimp } from 'jimp'
import { parseFaceBox, buildKeepFaceMask } from '../../src/media/facemask'

describe('parseFaceBox', () => {
  it('parses a box_2d JSON reply', () => {
    expect(parseFaceBox('{"box_2d":[100,200,400,500]}')).toEqual({ ymin: 100, xmin: 200, ymax: 400, xmax: 500 })
  })
  it('tolerates prose/markdown around it', () => {
    expect(parseFaceBox('Here it is:\n```json\n{"box_2d": [10, 20, 30, 40]}\n```')).toEqual({ ymin: 10, xmin: 20, ymax: 30, xmax: 40 })
  })
  it('falls back to a bare 4-number array', () => {
    expect(parseFaceBox('[5, 6, 700, 800]')).toEqual({ ymin: 5, xmin: 6, ymax: 700, xmax: 800 })
  })
  it('returns null on no-face / degenerate box', () => {
    expect(parseFaceBox('{"box_2d":null}')).toBeNull()
    expect(parseFaceBox('no face here')).toBeNull()
    expect(parseFaceBox('[100,100,100,100]')).toBeNull() // zero-area
  })
})

describe('buildKeepFaceMask', () => {
  it('white canvas, black (preserve) patch over the expanded face box', async () => {
    const src = await new Jimp({ width: 100, height: 100, color: 0x112233ff }).getBuffer('image/png')
    // face box centered-ish: normalized 400..600 x, 300..500 y → px 40..60, 30..50 (before expand)
    const maskBuf = await buildKeepFaceMask(src, { ymin: 300, xmin: 400, ymax: 500, xmax: 600 }, 0) // expand 0 for exact
    const mask = await Jimp.read(maskBuf)
    expect(mask.bitmap.width).toBe(100)
    const px = (x: number, y: number) => (mask.getPixelColor(x, y) >>> 0)
    const BLACK = 0x000000ff
    const WHITE = 0xffffffff
    expect(px(50, 40)).toBe(BLACK) // inside the box → preserved
    expect(px(5, 5)).toBe(WHITE) // corner → regenerate
    expect(px(90, 90)).toBe(WHITE)
  })

  it('expand grows the preserved region and clamps to image bounds', async () => {
    const src = await new Jimp({ width: 100, height: 100, color: 0xffffffff }).getBuffer('image/png')
    const mask = await Jimp.read(await buildKeepFaceMask(src, { ymin: 0, xmin: 0, ymax: 200, xmax: 200 }, 1))
    // box 0..20px expanded by 100% each side → clamps at 0, extends to ~40px; (0,0) preserved
    expect((mask.getPixelColor(0, 0) >>> 0)).toBe(0x000000ff)
  })
})
