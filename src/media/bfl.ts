// Black Forest Labs (FLUX) API client. Every BFL model — generate, FLUX.2 multi-ref edit,
// FLUX.1 Fill inpaint, finetuned inference — uses the SAME async shape:
//   POST /v1/<model> {x-key}  →  { id, polling_url }
//   GET  <polling_url>        →  { status, result: { sample: <signed url, 10-min> } }
//   download result.sample    →  the image bytes
// Images go in as RAW base64 (no data: prefix); multiple refs are input_image, input_image_2…
// fetch/sleep are injectable so the poll loop is testable without real time or network.

const BASE = process.env.GIZMO_BFL_BASE ?? 'https://api.bfl.ai/v1'

export interface BflOpts {
  timeoutMs?: number
  intervalMs?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export async function bflRun(model: string, body: Record<string, unknown>, apiKey: string, opts: BflOpts = {}): Promise<Buffer> {
  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = opts.timeoutMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 1500

  const submit = await doFetch(`${BASE}/${model}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-key': apiKey },
    body: JSON.stringify(body),
  })
  if (!submit.ok) throw new Error(`bfl ${model} ${submit.status}: ${(await submit.text()).slice(0, 150)}`)
  const { polling_url } = (await submit.json()) as { id?: string; polling_url?: string }
  if (!polling_url) throw new Error('bfl: submit returned no polling_url')

  const deadline = Date.now() + timeoutMs
  let sample: string | undefined
  while (Date.now() < deadline) {
    const poll = await doFetch(polling_url, { headers: { 'x-key': apiKey, accept: 'application/json' } })
    const j = (await poll.json()) as { status?: string; result?: { sample?: string } }
    if (j.status === 'Ready' && j.result?.sample) { sample = j.result.sample; break }
    if (j.status === 'Error' || j.status === 'Failed') throw new Error(`bfl generation ${j.status}`)
    await sleep(intervalMs)
  }
  if (!sample) throw new Error('bfl generation timed out')

  const img = await doFetch(sample)
  if (!img.ok) throw new Error(`bfl image download ${img.status}`)
  return Buffer.from(await img.arrayBuffer())
}

// input_image, input_image_2 … input_image_N (BFL's multi-reference field naming). Raw base64.
export function bflImageFields(images: Buffer[]): Record<string, string> {
  const out: Record<string, string> = {}
  images.forEach((b, i) => { out[i === 0 ? 'input_image' : `input_image_${i + 1}`] = b.toString('base64') })
  return out
}
