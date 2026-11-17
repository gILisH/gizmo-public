import { inflateRawSync } from 'node:zlib'
import { createWorker, type Worker } from 'tesseract.js'

// ── Groq Whisper (hosted STT) — keyless fetch to the OpenAI-compatible endpoint ──
export async function groqTranscribe(buf: Buffer, mimetype: string): Promise<string> {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('GROQ_API_KEY not set')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buf)], { type: mimetype || 'audio/ogg' }), 'audio.ogg')
  form.append('model', process.env.GIZMO_STT_MODEL ?? 'whisper-large-v3')
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  if (!res.ok) throw new Error(`groq stt ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { text: string }).text.trim()
}

// ── Tesseract.js OCR (local, Hebrew+English) — lazily-created reused worker ──
let workerPromise: Promise<Worker> | null = null
function getWorker(): Promise<Worker> {
  if (!workerPromise) workerPromise = createWorker('heb+eng')
  return workerPromise
}
export async function tesseractOcr(buf: Buffer): Promise<string> {
  const worker = await getWorker()
  const { data } = await worker.recognize(buf)
  return data.text.trim()
}

// ── Gemini vision (hosted, free tier) — understand a sent image, not just OCR it ──
// Returns a concise description INCLUDING any visible text (so it supersedes OCR).
export async function geminiVision(buf: Buffer, mimetype: string): Promise<string> {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!key) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set')
  const model = process.env.GIZMO_VISION_MODEL ?? 'gemini-2.5-flash'
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: 'Describe this image in one or two short sentences. Include any visible text verbatim. Reply in the language of the text if there is any, else English.' },
              { inline_data: { mime_type: mimetype || 'image/jpeg', data: buf.toString('base64') } },
            ],
          },
        ],
      }),
    },
  )
  if (!res.ok) throw new Error(`gemini vision ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const d = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  return (d.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
}

// ── HEIC/HEIF → JPEG (iPhone photos are often sent as .heic files) ──
// Pure-JS (libheif via wasm), so it works in node:22-slim. Non-heic buffers pass through.
export function isHeic(mimetype = '', filename = ''): boolean {
  const m = mimetype.toLowerCase()
  const f = filename.toLowerCase()
  return m.includes('heic') || m.includes('heif') || f.endsWith('.heic') || f.endsWith('.heif')
}
export async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const convert = (await import('heic-convert')).default
  const out = await convert({ buffer: new Uint8Array(buf), format: 'JPEG', quality: 0.92 })
  return Buffer.from(out)
}

// ── PDF text extraction (local) — embedded text only, not scanned-image OCR ──
export async function pdfText(buf: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default
  const data = await pdfParse(buf)
  return data.text.trim().slice(0, 8000)
}

// ── Documents: any text file, .docx, .xlsx, .eml, and .zip (recursive, guarded) ──
// Extracts plain text by file type, and any text file by content. Returns '' for binary types so the
// caller reports the file as unreadable. Pure-JS parsers only (node:22-slim has no office suite).
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|xml|html?|ini|conf|env|[jt]sx?|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|sql)$/i

// A zip entry's bytes, inflated under a hard cap; null when over it or unreadable. adm-zip's
// getData trusts the size the zip declares, and a declared 0 means no limit at all.
type ZipEntry = { header: { method: number }; getCompressedData(): Buffer }
function entryData(e: ZipEntry, max: number): Buffer | null {
  try {
    const raw = e.getCompressedData()
    const out = e.header.method === 8 ? inflateRawSync(raw, { maxOutputLength: max + 1 }) : e.header.method === 0 ? raw : null
    return out && out.length <= max ? out : null
  } catch {
    return null // over the cap mid-inflate, or a method we don't read
  }
}

// A docx/xlsx is a zip: a 98 KB file can inflate to 100 MB of XML. Measure every entry under
// a hard total before handing the file to a parser.
const OFFICE_MAX_UNZIPPED = 10_000_000
async function officeTooBig(buf: Buffer): Promise<boolean> {
  const AdmZip = (await import('adm-zip')).default
  let left = OFFICE_MAX_UNZIPPED
  try {
    for (const e of new AdmZip(buf).getEntries()) {
      if (e.isDirectory) continue
      const data = entryData(e, left)
      if (!data) return true
      left -= data.length
    }
  } catch {
    return true // not a readable zip
  }
  return false
}

export async function docText(buf: Buffer, filename = '', mimetype = ''): Promise<string> {
  const name = filename.toLowerCase()
  if (/\.(docx|xlsx|xlsm)$/.test(name) && (await officeTooBig(buf))) return ''
  if (name.endsWith('.docx')) {
    const mammoth = await import('mammoth')
    return (await mammoth.extractRawText({ buffer: buf })).value.trim()
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    const sheets: string[] = []
    wb.eachSheet((ws) => {
      const rows: string[] = []
      ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v))).join(',')))
      sheets.push(`# ${ws.name}\n${rows.join('\n')}`)
    })
    return sheets.join('\n\n').trim()
  }
  if (name.endsWith('.zip')) return zipText(buf)
  if (name.endsWith('.eml') || mimetype === 'message/rfc822') return emlText(buf)
  if (TEXT_EXT.test(name) || mimetype.startsWith('text/') || looksLikeText(buf)) return buf.toString('utf8').trim()
  return ''
}

// Any file whose bytes ARE text reads as text, whatever its suffix (.ics, .vcf, .srt, .nfo…):
// valid UTF-8 and no NUL bytes. Binary formats fail one or the other.
function looksLikeText(buf: Buffer): boolean {
  if (!buf.length || buf.subarray(0, 8192).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

// A saved email: headers + body + attachments (read through docText/pdfText). postal-mime
// decodes base64/quoted-printable and charsets — raw .eml text is unreadable without it.
// Nested .eml attachments are listed, not opened (one level, like zip).
async function emlText(buf: Buffer): Promise<string> {
  const PostalMime = (await import('postal-mime')).default
  const e = await PostalMime.parse(buf)
  const who = (a?: { name?: string; address?: string }) => (a ? (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')) : '')
  const head = [
    `From: ${who(e.from)}`,
    e.to?.length ? `To: ${e.to.map(who).join(', ')}` : '',
    e.date ? `Date: ${e.date}` : '',
    `Subject: ${e.subject ?? ''}`,
  ].filter(Boolean)
  const body = e.text?.trim() || htmlToText(e.html ?? '')
  const atts: string[] = []
  for (const a of e.attachments.slice(0, 10)) {
    if (a.disposition === 'inline' && a.mimeType.startsWith('image/')) continue // logos/tracking pixels
    const fname = a.filename ?? 'attachment'
    const bytes = Buffer.from(a.content as ArrayBuffer)
    let t = ''
    try {
      if (a.mimeType.includes('pdf') || fname.toLowerCase().endsWith('.pdf')) t = await pdfText(bytes)
      else if (a.mimeType !== 'message/rfc822' && !fname.toLowerCase().endsWith('.eml')) t = await docText(bytes, fname, a.mimeType)
    } catch {
      /* unreadable attachment: still listed by name below */
    }
    atts.push(t ? `## Attachment: ${fname}\n${t.slice(0, 8000)}` : `## Attachment: ${fname} (not readable)`)
  }
  return [head.join('\n'), body, ...atts].filter(Boolean).join('\n\n').trim()
}

// HTML-only emails (most booking confirmations): keep the text, drop markup.
// ponytail: regex strip, not a DOM — tables flatten to lines, good enough to read details.
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

// Unpack a zip and read every supported file inside. Guards against zip-bombs:
// caps entry count, per-entry size, and total extracted text; does NOT recurse into
// nested zips (one level only).
async function zipText(buf: Buffer): Promise<string> {
  const AdmZip = (await import('adm-zip')).default
  const parts: string[] = []
  let total = 0
  let count = 0
  for (const entry of new AdmZip(buf).getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    if (name.toLowerCase().endsWith('.zip')) continue // no nested-zip recursion
    if (++count > 50) {
      parts.push('…(more files omitted)')
      break
    }
    const data = entryData(entry, 5_000_000) // skip a huge single entry (by real size, not the declared one)
    if (!data) continue
    const t = (await docText(data, name)).trim()
    if (!t) continue
    parts.push(`--- ${name} ---\n${t}`)
    total += t.length
    if (total > 24_000) {
      parts.push('…(truncated)')
      break
    }
  }
  return parts.join('\n\n')
}
