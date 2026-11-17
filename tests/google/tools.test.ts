import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGoogleTools, openCreatedIds, docIdOf } from '../../src/google/tools'

const created = () => openCreatedIds(join(mkdtempSync(join(tmpdir(), 'gizmo-g-')), 'created.json'))
const call = (t: any, args: any) => t.execute(args, { toolCallId: 't', messages: [] })

describe('makeGoogleTools', () => {
  it('exposes the expected read + write tools', () => {
    const tools = makeGoogleTools({} as any, created()) // client construction is offline
    expect(Object.keys(tools).sort()).toEqual(
      [
        'calendar_create',
        'calendar_upcoming',
        'doc_append',
        'doc_create',
        'doc_read',
        'gmail_read',
        'gmail_search',
        'sheet_append',
        'sheet_create',
        'sheet_read',
      ].sort(),
    )
  })

  it("refuses to append to a doc or sheet Gizmo didn't create (no API call)", async () => {
    const tools: any = makeGoogleTools({} as any, created())
    expect(await call(tools.doc_append, { documentId: 'someone-elses-doc', text: 'x' })).toMatch(/^refused: I only add to documents I created/)
    expect(await call(tools.sheet_append, { spreadsheetId: 'https://docs.google.com/spreadsheets/d/abc123/edit', range: 'A1', values: ['x'] })).toMatch(/^refused/)
  })

  it('remembers created ids across restarts, and reads ids out of links', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gizmo-g-')), 'created.json')
    openCreatedIds(path).add('abc_123-x')
    const again = openCreatedIds(path)
    expect(again.has(docIdOf('https://docs.google.com/document/d/abc_123-x/edit'))).toBe(true)
    expect(again.has('other')).toBe(false)
  })
})
