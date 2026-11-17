import { describe, it, expect } from 'vitest'
import { docText } from '../../src/media/providers'
import AdmZip from 'adm-zip'
import ExcelJS from 'exceljs'

describe('docText — plain text', () => {
  it('decodes txt/md/csv/json/code by extension', async () => {
    expect(await docText(Buffer.from('hello world'), 'notes.txt')).toBe('hello world')
    expect(await docText(Buffer.from('a,b\n1,2'), 'data.csv')).toBe('a,b\n1,2')
    expect(await docText(Buffer.from('{"x":1}'), 'cfg.json')).toBe('{"x":1}')
    expect(await docText(Buffer.from('const x=1'), 'app.ts')).toBe('const x=1')
  })
  it('decodes by text/* mimetype even with an unknown extension', async () => {
    expect(await docText(Buffer.from('log line'), 'weird.dat', 'text/plain')).toBe('log line')
  })
  it('returns empty for an unsupported binary type', async () => {
    expect(await docText(Buffer.from([0, 1, 2]), 'thing.bin', 'application/octet-stream')).toBe('')
  })
})

describe('docText — xlsx', () => {
  it('reads cells to CSV-ish text per sheet', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.addRow(['name', 'age'])
    ws.addRow(['alice', 30])
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const out = await docText(buf, 'people.xlsx')
    expect(out).toContain('alice')
    expect(out).toContain('30')
    expect(out).toContain('name')
  })
})

describe('docText — zip (recursive, guarded)', () => {
  it('reads supported files inside and labels them', async () => {
    const zip = new AdmZip()
    zip.addFile('readme.txt', Buffer.from('inside the zip'))
    zip.addFile('data.csv', Buffer.from('x,y\n1,2'))
    const out = await docText(zip.toBuffer(), 'bundle.zip')
    expect(out).toContain('readme.txt')
    expect(out).toContain('inside the zip')
    expect(out).toContain('data.csv')
  })
  it('skips nested zips (no zip-bomb recursion)', async () => {
    const inner = new AdmZip(); inner.addFile('deep.txt', Buffer.from('boom'))
    const outer = new AdmZip()
    outer.addFile('nested.zip', inner.toBuffer())
    outer.addFile('ok.txt', Buffer.from('safe'))
    const out = await docText(outer.toBuffer(), 'outer.zip')
    expect(out).toContain('safe')
    expect(out).not.toContain('boom') // nested zip not expanded
  })
})

describe('docText — any text file, whatever the suffix', () => {
  it('reads text by content (.ics, no-extension), not by name', async () => {
    expect(await docText(Buffer.from('BEGIN:VCALENDAR\nSUMMARY:טיסה\nEND:VCALENDAR'), 'flight.ics', 'application/octet-stream')).toContain('SUMMARY:טיסה')
    expect(await docText(Buffer.from('plain words'), 'README')).toBe('plain words')
  })
  it('binary stays unread: NUL bytes, or invalid UTF-8', async () => {
    expect(await docText(Buffer.from([0x50, 0x4b, 0x00, 0x01]), 'x.dat')).toBe('')
    expect(await docText(Buffer.from([0xff, 0xfe, 0xfd, 0x41]), 'x.dat')).toBe('')
  })
})

describe('docText — eml', () => {
  const eml = [
    'From: "Hyatt Centric" <reservations@hyatt.com>',
    'To: dan@example.com',
    `Subject: =?UTF-8?B?${Buffer.from('ההזמנה שלך').toString('base64')}?=`,
    'Date: Tue, 27 Oct 2026 09:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<html><head><style>p{color:red}</style></head><body><table><tr><td>Check-in</t=',
    'd><td>Nov 3</td></tr></table><p>Confirmation&nbsp;#12345</p><p>=D7=A9=D7=9C=D7=95=D7=9D</p></body></html>',
    '--B',
    'Content-Type: image/png',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--B',
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('late checkout requested').toString('base64'),
    '--B--',
    '',
  ].join('\r\n')

  it('reads headers, the HTML-only body (decoded), and text attachments; skips inline logos', async () => {
    const out = await docText(Buffer.from(eml), 'Reservation Details.eml', 'message/rfc822')
    expect(out).toContain('From: Hyatt Centric <reservations@hyatt.com>')
    expect(out).toContain('Subject: ההזמנה שלך')
    expect(out).toContain('Check-in Nov 3')
    expect(out).toContain('Confirmation #12345')
    expect(out).toContain('שלום')
    expect(out).toContain('## Attachment: notes.txt\nlate checkout requested')
    expect(out).not.toContain('logo.png')
    expect(out).not.toMatch(/<td>|color:red/)
  })
})

describe('docText — document bombs', () => {
  it('refuses a docx/xlsx whose entries inflate past the cap, before parsing', async () => {
    const zip = new AdmZip()
    zip.addFile('word/document.xml', Buffer.alloc(11_000_000, 'a')) // compresses to ~11 KB
    const buf = zip.toBuffer()
    expect(buf.length).toBeLessThan(100_000)
    expect(await docText(buf, 'bomb.docx')).toBe('')
    expect(await docText(buf, 'bomb.xlsx')).toBe('')
  })
  it('a .zip entry that declares size 0 is still capped by its real size', async () => {
    const zip = new AdmZip()
    zip.addFile('a.txt', Buffer.alloc(6_000_000, 'a'))
    const buf = zip.toBuffer()
    // Forge "uncompressed size = 0" in the local and central headers (adm-zip then inflates with no limit).
    for (let i = 0; i < buf.length - 4; i++) {
      const sig = buf.readUInt32LE(i)
      if (sig === 0x04034b50) buf.writeUInt32LE(0, i + 22)
      if (sig === 0x02014b50) buf.writeUInt32LE(0, i + 24)
    }
    expect(await docText(buf, 'bomb.zip')).toBe('')
  })
})
