import { Jimp } from 'jimp'
import { generateText } from 'ai'
import { google } from '@ai-sdk/google'

// Face-lock inpainting support: find the face, build a Fill mask that PRESERVES it.
// FLUX.1 Fill mask convention: WHITE = regenerate, BLACK = keep. So "change everything,
// keep the face" = a white canvas with a black patch over the (expanded) face box.
//
// Face detection reuses the gemini vision key we already have (Gemini returns normalized
// 0–1000 bounding boxes) — NO new heavy ML dependency (important on the small droplet).
// The mask is drawn with jimp (already a dep for baileys thumbnails).

export interface FaceBox { ymin: number; xmin: number; ymax: number; xmax: number } // normalized 0–1000

// Pull the first [ymin,xmin,ymax,xmax] out of gemini's reply (tolerates prose/markdown/box_2d).
export function parseFaceBox(text: string): FaceBox | null {
  // Prefer an explicit box_2d, else the first 4-number array.
  const m = text.match(/"?box_2d"?\s*:\s*\[([^\]]+)\]/) ?? text.match(/\[\s*(\d[\d\s.,]*\d)\s*\]/)
  if (!m) return null
  const n = m[1].split(/[,\s]+/).map(Number).filter((x) => !Number.isNaN(x))
  if (n.length < 4) return null
  const [ymin, xmin, ymax, xmax] = n
  if (ymax <= ymin || xmax <= xmin) return null
  return { ymin, xmin, ymax, xmax }
}

export async function detectFaceBox(image: Buffer, opts: { model?: string } = {}): Promise<FaceBox | null> {
  const model = opts.model ?? process.env.GIZMO_GEMINI_VISION_MODEL ?? 'gemini-2.5-flash'
  const result = await generateText({
    model: google(model),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Return ONLY JSON, no prose: the bounding box of the main person\'s FACE INCLUDING hair, ears and neck, as {"box_2d":[ymin,xmin,ymax,xmax]} normalized to 0-1000. If no face, return {"box_2d":null}.',
          },
          { type: 'file', data: image, mediaType: 'image/jpeg' },
        ],
      },
    ],
  })
  return parseFaceBox(result.text ?? '')
}

// White (=regenerate) canvas with a black (=preserve) patch over the face box, expanded by
// `expand` (fraction of box size each side) so hair/ears/neck stay locked, not just a tight crop.
export async function buildKeepFaceMask(image: Buffer, box: FaceBox, expand = 0.25): Promise<Buffer> {
  const base = await Jimp.read(image)
  const { width: W, height: H } = base.bitmap
  const mask = new Jimp({ width: W, height: H, color: 0xffffffff }) // all regenerate
  const bw = box.xmax - box.xmin
  const bh = box.ymax - box.ymin
  const x0 = Math.max(0, Math.round(((box.xmin - bw * expand) / 1000) * W))
  const y0 = Math.max(0, Math.round(((box.ymin - bh * expand) / 1000) * H))
  const x1 = Math.min(W, Math.round(((box.xmax + bw * expand) / 1000) * W))
  const y1 = Math.min(H, Math.round(((box.ymax + bh * expand) / 1000) * H))
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask.setPixelColor(0x000000ff, x, y)
  return await mask.getBuffer('image/png')
}
