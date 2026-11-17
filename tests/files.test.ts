import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { openFileStore, renderFile, toCsv } from '../src/files'
import { fileTools } from '../src/brain/tools/files'
import type { BrainDeps } from '../src/brain/types'

const DM = 'a@s.whatsapp.net'
const GROUP = 'fam@g.us'
const store = () => openFileStore(mkdtempSync(join(tmpdir(), 'gizmo-files-')), () => 1000)
const call = (t: any, args: any = {}) => t.execute(args, { toolCallId: 't', messages: [] })

describe('file store', () => {
  it('keeps files per chat, and "List.csv" / "list" are the same file', () => {
    const s = store()
    s.save(DM, { name: 'Shopping List.csv', format: 'csv', rows: [['item'], ['חלב']] })
    expect(s.get(DM, 'shopping list')?.rows).toEqual([['item'], ['חלב']])
    expect(s.get(DM, 'Shopping List')?.name).toBe('Shopping List')
    expect(s.get(GROUP, 'shopping list')).toBeUndefined()
    expect(s.list(GROUP)).toEqual([])
    expect(s.remove(DM, 'shopping list')).toBe(true)
    expect(s.list(DM)).toEqual([])
  })
})

describe('rendering', () => {
  it('csv: BOM for Excel + RFC-4180 quoting', () => {
    expect(toCsv([['a', 'b,c'], ['say "hi"', 'x\ny']])).toBe('﻿a,"b,c"\r\n"say ""hi""","x\ny"')
  })

  it('xlsx round-trips the rows, right-to-left when Hebrew', async () => {
    const { buffer, fileName, mimetype } = await renderFile({ name: 'budget', format: 'xlsx', rows: [['פריט', 'סכום'], ['שכירות', '5000']], updatedAt: 0 })
    expect(fileName).toBe('budget.xlsx')
    expect(mimetype).toContain('spreadsheetml')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const ws = wb.getWorksheet('Sheet1')!
    expect(ws.getRow(2).values).toEqual([undefined, 'שכירות', '5000'])
    expect(ws.views[0].rightToLeft).toBe(true)
  })

  it('pdf: a real multi-page PDF from Hebrew + English text', async () => {
    const text = Array.from({ length: 120 }, (_, i) => (i % 2 ? `שורה ${i} חלב, Coca Cola` : `line ${i}`)).join('\n')
    const { buffer } = await renderFile({ name: 'n', format: 'pdf', text, updatedAt: 0 })
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect((buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1)
  })
})

describe('file tools', () => {
  it('save → read → edit → resend converted, all in the current chat', async () => {
    const sent: any[] = []
    const deps = { files: store(), sendDocument: async (...a: any[]) => { sent.push(a) } } as unknown as BrainDeps
    const t: any = fileTools(deps, 'u', { chatJid: GROUP })
    expect(await call(t.save_file, { name: 'list', format: 'csv', rows: [['item'], ['eggs']] })).toBe('saved and sent list.csv')
    expect(await call(t.read_file, { name: 'list' })).toBe('list (csv, table):\nitem\r\neggs')
    await call(t.save_file, { name: 'list', format: 'csv', rows: [['item'], ['eggs'], ['milk']], send: false })
    expect(await call(t.send_file, { name: 'list', as: 'xlsx' })).toBe('sent list.xlsx')
    expect(sent.map((s) => [s[0], s[2]])).toEqual([[GROUP, 'list.csv'], [GROUP, 'list.xlsx']])
    expect(await call(t.list_files)).toMatch(/^list \(csv, 3 rows/)
    expect(await call(t.read_file, { name: 'nope' })).toMatch(/no file "nope"/)
  })

  it('no tools without both deps', () => {
    expect(fileTools({ files: store() } as unknown as BrainDeps, 'u', {})).toEqual({})
  })
})
