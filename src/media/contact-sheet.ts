import { Jimp } from 'jimp'

// Tile several photos of ONE person into a single contact-sheet image (a grid of the same
// face from different angles). Identity-conditioned image models read this as one subject
// with MORE identity signal — the opposite of passing N separate images (which the model
// renders as N different people). One person → one rich reference, no duplication.
//
// 0 photos → null; 1 → the photo as-is (no point tiling); 2–4 → a 2-col grid of 512px cells.
const CELL = 512
const MAX = 4

export async function makeContactSheet(photos: Buffer[]): Promise<Buffer | null> {
  if (photos.length === 0) return null
  if (photos.length === 1) return photos[0]!
  const used = photos.slice(0, MAX)
  const cols = 2
  const rows = Math.ceil(used.length / cols)
  try {
    const sheet = new Jimp({ width: cols * CELL, height: rows * CELL, color: 0xffffffff })
    for (let i = 0; i < used.length; i++) {
      const cell = await Jimp.read(used[i]!)
      cell.resize({ w: CELL, h: CELL })
      sheet.composite(cell, (i % cols) * CELL, Math.floor(i / cols) * CELL)
    }
    return Buffer.from(await sheet.getBuffer('image/jpeg'))
  } catch (err) {
    // A corrupt/undecodable saved photo must never break scene generation — fall back to
    // the first photo (still a valid single reference).
    console.error('contact sheet failed, using first photo:', (err as Error).message)
    return photos[0]!
  }
}
