import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FileFormat = 'csv' | 'xlsx' | 'pdf' | 'txt'

// A file Gizmo made, stored as its SOURCE (table rows or text), not its bytes — so it can be
// read back, edited, and re-rendered in any format. Bytes are produced on send by renderFile.
export interface StoredFile {
  name: string
  format: FileFormat
  rows?: string[][]
  text?: string
  updatedAt: number
}

export interface FileStore {
  save(chatJid: string, f: Omit<StoredFile, 'updatedAt'>): StoredFile
  get(chatJid: string, name: string): StoredFile | undefined
  list(chatJid: string): StoredFile[]
  remove(chatJid: string, name: string): boolean
}

// Per-CHAT storage: a DM's files and a group's files never mix (same hashed-dir scheme as memory).
export function openFileStore(rootDir: string, now = () => Date.now()): FileStore {
  const dirFor = (chatJid: string) => {
    const d = join(rootDir, createHash('sha256').update(chatJid).digest('hex').slice(0, 16))
    mkdirSync(d, { recursive: true })
    return d
  }
  const pathFor = (chatJid: string, name: string) => join(dirFor(chatJid), `${fileKey(name)}.json`)
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as StoredFile
  return {
    save(chatJid, f) {
      const stored = { ...f, name: baseName(f.name), updatedAt: now() }
      writeFileSync(pathFor(chatJid, f.name), JSON.stringify(stored))
      return stored
    },
    get(chatJid, name) {
      const p = pathFor(chatJid, name)
      return existsSync(p) ? read(p) : undefined
    },
    list(chatJid) {
      const d = dirFor(chatJid)
      return readdirSync(d).filter((n) => n.endsWith('.json')).map((n) => read(join(d, n))).sort((a, b) => b.updatedAt - a.updatedAt)
    },
    remove(chatJid, name) {
      const p = pathFor(chatJid, name)
      if (!existsSync(p)) return false
      rmSync(p)
      return true
    },
  }
}

// "Shopping List.csv" and "shopping list" are the same file.
const baseName = (name: string) => name.trim().replace(/\.(csv|xlsx|pdf|txt)$/i, '')
const fileKey = (name: string) => baseName(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'file'

// Any source renders to any format: rows → text joins cells; text → rows is one cell per line.
export const asText = (f: Pick<StoredFile, 'rows' | 'text'>) => f.text ?? (f.rows ?? []).map((r) => r.join(', ')).join('\n')
export const asRows = (f: Pick<StoredFile, 'rows' | 'text'>) => f.rows ?? (f.text ?? '').split('\n').map((l) => [l])

const MIME: Record<FileFormat, string> = {
  csv: 'text/csv',
  txt: 'text/plain',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const HEB = /[֐-׿]/

export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  // BOM: without it Excel opens UTF-8 Hebrew as gibberish.
  return '﻿' + rows.map((r) => r.map((v) => cell(String(v ?? ''))).join(',')).join('\r\n')
}

export async function renderFile(f: StoredFile, format: FileFormat = f.format): Promise<{ buffer: Buffer; fileName: string; mimetype: string }> {
  const fileName = `${f.name}.${format}`
  const out = (buffer: Buffer) => ({ buffer, fileName, mimetype: MIME[format] })
  if (format === 'txt') return out(Buffer.from(asText(f), 'utf8'))
  if (format === 'csv') return out(Buffer.from(toCsv(asRows(f)), 'utf8'))
  if (format === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const rows = asRows(f)
    const ws = wb.addWorksheet('Sheet1', { views: [{ rightToLeft: rows.some((r) => r.some((c) => HEB.test(c))) }] })
    ws.addRows(rows)
    return out(Buffer.from(await wb.xlsx.writeBuffer()))
  }
  return out(await renderPdf(asText(f)))
}

// Hebrew-capable font: box has DejaVu (Dockerfile), a Mac has Arial Unicode. GIZMO_PDF_FONT overrides.
// ponytail: no font found → built-in Helvetica, which renders Latin only.
const FONT = [process.env.GIZMO_PDF_FONT, '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'].find(
  (p) => p && existsSync(p),
)

async function renderPdf(text: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default
  const doc = new PDFDocument({ size: 'A4', margin: 50 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))
  if (FONT) doc.font(FONT)
  doc.fontSize(12)
  const { left, right, bottom } = doc.page.margins
  const width = doc.page.width - left - right
  const lh = doc.currentLineHeight(true) * 1.2
  let y = doc.page.margins.top
  const line = (draw: () => void) => {
    if (y + lh > doc.page.height - bottom) {
      doc.addPage()
      y = doc.page.margins.top
    }
    draw()
    y += lh
  }
  for (const para of text.split('\n')) {
    const rtl = HEB.test(para.match(/[\p{L}]/u)?.[0] ?? '') // first letter sets the direction
    for (const words of wrap(para, width, (s) => doc.widthOfString(s))) {
      line(() => (rtl ? drawRtl(doc, words, left + width, y) : doc.text(words.join(' '), left, y, { lineBreak: false })))
    }
  }
  doc.end()
  return done
}

// Greedy word wrap → lines as word arrays. An empty paragraph keeps its blank line.
function wrap(para: string, width: number, measure: (s: string) => number): string[][] {
  const lines: string[][] = [[]]
  for (const w of para.split(/\s+/).filter(Boolean)) {
    const cur = lines.at(-1)!
    if (cur.length && measure([...cur, w].join(' ')) > width) lines.push([w])
    else cur.push(w)
  }
  return lines
}

// pdfkit shapes letters inside a Hebrew word correctly but lays WORDS out left-to-right.
// So place words ourselves from the right edge; consecutive non-Hebrew words ("Coca Cola")
// stay one left-to-right unit. ponytail: word-level bidi, not full UAX#9 — enough for lists/notes.
function drawRtl(doc: PDFKit.PDFDocument, words: string[], rightX: number, y: number) {
  const units: string[] = []
  for (const w of words) {
    const last = units.at(-1)
    if (last !== undefined && !HEB.test(w) && !HEB.test(last)) units[units.length - 1] = `${last} ${w}`
    else units.push(w)
  }
  const space = doc.widthOfString(' ')
  let x = rightX
  for (const u of units) {
    x -= doc.widthOfString(u)
    doc.text(u, x, y, { lineBreak: false })
    x -= space
  }
}
