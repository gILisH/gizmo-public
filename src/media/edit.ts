import { generateText } from 'ai'
import { google } from '@ai-sdk/google'
import { bflRun, bflImageFields } from './bfl'

// AI image EDITING (img2img): take an existing photo + a natural-language instruction,
// return the modified image. Two providers, mirroring the dual-brain pattern —
// gemini = Gemini 2.5 Flash Image ("nano-banana"), grok = xAI grok-imagine. Built from
// whichever API keys exist; callers pick per-request with a default + fallback.

export const EDITORS = ['gemini', 'grok', 'flux'] as const
export type EditorName = (typeof EDITORS)[number]
// Editors that can fuse MULTIPLE reference images (compose scenes / place people). grok's
// edit endpoint is single-image; gemini (nano-banana) and flux (FLUX.2 multi-reference) fuse.
export const MULTI_CAPABLE: EditorName[] = ['gemini', 'flux']
// Takes 1+ images: one → plain edit; several → compose/fuse them (gemini/flux only).
export type ImageEditor = (images: Buffer[], instruction: string) => Promise<Buffer>

// Gemini: multimodal generateText with IMAGE response modality; edited image in result.files.
// Multiple images → nano-banana fusion ("put this guy into that photo, next to the other one").
export async function geminiEditImage(images: Buffer[], instruction: string): Promise<Buffer> {
  const model = process.env.GIZMO_GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image'
  const result = await generateText({
    model: google(model),
    providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          ...images.map((data) => ({ type: 'file' as const, data, mediaType: 'image/jpeg' })),
        ],
      },
    ],
  })
  const file = result.files?.find((f) => f.mediaType?.startsWith('image/'))
  if (!file) throw new Error(`gemini returned no image (${result.text?.slice(0, 120) || 'no text'})`)
  return Buffer.from(file.uint8Array)
}

// xAI: POST /v1/images/edits (JSON — not the OpenAI multipart shape), image as data-URI.
export async function grokEditImage(image: Buffer, instruction: string, apiKey: string): Promise<Buffer> {
  const model = process.env.GIZMO_GROK_IMAGE_MODEL ?? 'grok-imagine-image-quality'
  const res = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      prompt: instruction,
      image: { type: 'image_url', url: `data:image/jpeg;base64,${image.toString('base64')}` },
      response_format: 'b64_json',
    }),
  })
  if (!res.ok) throw new Error(`grok image edit ${res.status}: ${(await res.text()).slice(0, 150)}`)
  const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] }
  const first = data.data?.[0]
  if (first?.b64_json) return Buffer.from(first.b64_json, 'base64')
  if (first?.url) {
    const img = await fetch(first.url)
    if (!img.ok) throw new Error(`grok image download ${img.status}`)
    return Buffer.from(await img.arrayBuffer())
  }
  throw new Error('grok image edit: empty response')
}

// FLUX via Black Forest Labs (BFL). FLUX.2 [pro] does multi-reference editing — feed the
// base + reference faces and it fuses identity (up to 8 refs), the same role as gemini's
// nano-banana. Async submit→poll→download is handled by bflRun; images go in as raw base64
// (input_image, input_image_2 …). Model ids are env-overridable.
const FLUX_EDIT_MODEL = process.env.GIZMO_FLUX_EDIT_MODEL ?? 'flux-2-pro'
const FLUX_GEN_MODEL = process.env.GIZMO_FLUX_MODEL ?? 'flux-2-pro'

export async function fluxEditImage(images: Buffer[], instruction: string, apiKey: string): Promise<Buffer> {
  return bflRun(FLUX_EDIT_MODEL, { prompt: instruction, ...bflImageFields(images) }, apiKey)
}

export async function fluxGenerateImage(prompt: string, apiKey: string): Promise<Buffer> {
  return bflRun(FLUX_GEN_MODEL, { prompt, width: 1024, height: 1024 }, apiKey)
}

// FLUX.1 Fill (inpaint): regenerate the WHITE regions of `mask`, keep the BLACK ones. Used
// for face-lock edits (mask = black over the face) — the face stays pixel-identical.
const FLUX_FILL_MODEL = process.env.GIZMO_FLUX_FILL_MODEL ?? 'flux-pro-1.0-fill'
export async function fluxFillImage(image: Buffer, mask: Buffer, prompt: string, apiKey: string): Promise<Buffer> {
  return bflRun(FLUX_FILL_MODEL, { image: image.toString('base64'), mask: mask.toString('base64'), prompt }, apiKey)
}

// Editors available given the keys in the environment.
export function editorsFromEnv(): Partial<Record<EditorName, ImageEditor>> {
  const editors: Partial<Record<EditorName, ImageEditor>> = {}
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) editors.gemini = geminiEditImage
  const xaiKey = process.env.XAI_API_KEY
  // grok's edit endpoint is single-image — feed it the most recent photo.
  if (xaiKey) editors.grok = (imgs, instr) => grokEditImage(imgs[imgs.length - 1]!, instr, xaiKey)
  const bflKey = process.env.BFL_API_KEY
  if (bflKey) editors.flux = (imgs, instr) => fluxEditImage(imgs, instr, bflKey)
  return editors
}

// Multi-image compose needs a fusion-capable editor (gemini or flux; grok is single-image).
// When combining, honor the request if it can fuse, else prefer the fallback if it can,
// else any multi-capable editor present. Single-image → resolve normally.
export function chooseEditor(
  multi: boolean,
  requested: EditorName | undefined,
  available: Partial<Record<EditorName, ImageEditor>>,
  fallback: EditorName = 'gemini',
): EditorName | undefined {
  if (multi) {
    if (requested && MULTI_CAPABLE.includes(requested) && available[requested]) return requested
    if (MULTI_CAPABLE.includes(fallback) && available[fallback]) return fallback
    return MULTI_CAPABLE.find((n) => available[n])
  }
  return pickEditor(requested, available, fallback)
}

// Resolve which editor to use: explicit request → default → whatever exists.
export function pickEditor(
  requested: EditorName | undefined,
  available: Partial<Record<EditorName, ImageEditor>>,
  fallback: EditorName,
): EditorName | undefined {
  if (requested && available[requested]) return requested
  if (available[fallback]) return fallback
  return (Object.keys(available) as EditorName[])[0]
}
