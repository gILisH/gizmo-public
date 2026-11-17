import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { tool } from 'ai'
import { z } from 'zod'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// Decode a Gmail message body: prefer text/plain, walk MIME parts.
function extractBody(payload: any): string {
  if (!payload) return ''
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64').toString('utf8')
  for (const part of payload.parts ?? []) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf8')
    }
  }
  for (const part of payload.parts ?? []) {
    const nested = extractBody(part)
    if (nested) return nested
  }
  return ''
}

const header = (msg: any, name: string): string =>
  (msg.payload?.headers ?? []).find((h: any) => h.name === name)?.value ?? ''

// The Docs/Sheets Gizmo created itself (a JSON list of ids). Appends go ONLY to these: text
// that steered a turn can't make Gizmo write into the owner's other documents.
export function openCreatedIds(path: string) {
  const ids = new Set<string>(existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as string[]) : [])
  return {
    has: (id: string) => ids.has(id),
    add: (id: string) => {
      ids.add(id)
      writeFileSync(path, JSON.stringify([...ids]))
    },
  }
}

// A pasted link works as well as a bare id.
export const docIdOf = (s: string) => s.match(/\/d\/([\w-]+)/)?.[1] ?? s.trim()
const NOT_OURS = "refused: I only add to documents I created myself. Ask the owner to paste the text in, or I can create a new one."

// All tools operate as the OWNER's authorized client — the composition root only
// exposes these to the single Google-owner speaker.
export function makeGoogleTools(auth: OAuth2Client, created: ReturnType<typeof openCreatedIds>) {
  const gmail = google.gmail({ version: 'v1', auth })
  const calendar = google.calendar({ version: 'v3', auth })
  const docs = google.docs({ version: 'v1', auth })
  const sheets = google.sheets({ version: 'v4', auth })
  const createdIds = created

  return {
    // ── Gmail (read-only) ──
    gmail_search: tool({
      description: 'Search the owner\'s Gmail (Gmail query syntax, e.g. "from:bank newer_than:7d"). Returns subject/from/date/snippet + message ids.',
      inputSchema: z.object({ query: z.string(), limit: z.number().max(15).optional() }),
      execute: async ({ query, limit }) => {
        const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: limit ?? 8 })
        const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean)
        if (ids.length === 0) return 'no matching emails'
        const rows = await Promise.all(
          ids.map(async (id) => {
            const m = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })
            return `#${id} | ${header(m.data, 'Date')} | ${header(m.data, 'From')} | ${header(m.data, 'Subject')} — ${m.data.snippet ?? ''}`
          }),
        )
        return rows.join('\n')
      },
    }),
    gmail_read: tool({
      description: 'Read the full body of one Gmail message by id (from gmail_search).',
      inputSchema: z.object({ messageId: z.string() }),
      execute: async ({ messageId }) => {
        const m = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
        const body = extractBody(m.data.payload).slice(0, 4000)
        return `From: ${header(m.data, 'From')}\nSubject: ${header(m.data, 'Subject')}\nDate: ${header(m.data, 'Date')}\n\n${body}`
      },
    }),

    // ── Calendar (read + create) ──
    calendar_upcoming: tool({
      description: 'List the owner\'s upcoming calendar events.',
      inputSchema: z.object({ limit: z.number().max(20).optional() }),
      execute: async ({ limit }) => {
        const res = await calendar.events.list({ calendarId: 'primary', timeMin: new Date().toISOString(), maxResults: limit ?? 10, singleEvents: true, orderBy: 'startTime' })
        const events = res.data.items ?? []
        if (events.length === 0) return 'no upcoming events'
        return events.map((e) => `${e.start?.dateTime ?? e.start?.date} — ${e.summary ?? '(no title)'}`).join('\n')
      },
    }),
    calendar_create: tool({
      description: 'Create a calendar event. Times are ISO 8601 (e.g. 2026-06-12T20:00:00+03:00).',
      inputSchema: z.object({
        title: z.string(),
        start: z.string().describe('ISO start datetime'),
        end: z.string().describe('ISO end datetime'),
        description: z.string().optional(),
        location: z.string().optional(),
      }),
      execute: async ({ title, start, end, description, location }) => {
        const res = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: { summary: title, description, location, start: { dateTime: start }, end: { dateTime: end } },
        })
        return `created event "${title}" (${res.data.htmlLink ?? res.data.id})`
      },
    }),

    // ── Docs (read + create/append) ──
    doc_read: tool({
      description: 'Read the text of a Google Doc by its document id (e.g. from a Docs link).',
      inputSchema: z.object({ documentId: z.string() }),
      execute: async ({ documentId }) => {
        const doc = await docs.documents.get({ documentId })
        const text = (doc.data.body?.content ?? [])
          .flatMap((el) => (el.paragraph?.elements ?? []).map((pe) => pe.textRun?.content ?? ''))
          .join('')
        return text.slice(0, 4000) || '(empty document)'
      },
    }),
    doc_create: tool({
      description: 'Create a new Google Doc with a title and optional initial text. Returns the doc id + link.',
      inputSchema: z.object({ title: z.string(), text: z.string().optional() }),
      execute: async ({ title, text }) => {
        const created = await docs.documents.create({ requestBody: { title } })
        const id = created.data.documentId!
        createdIds.add(id)
        if (text) {
          await docs.documents.batchUpdate({ documentId: id, requestBody: { requests: [{ insertText: { location: { index: 1 }, text } }] } })
        }
        return `created doc "${title}" — https://docs.google.com/document/d/${id}/edit`
      },
    }),
    doc_append: tool({
      description: 'Append text to the end of a Google Doc YOU created (doc_create), by id or link. Other documents are refused.',
      inputSchema: z.object({ documentId: z.string(), text: z.string() }),
      execute: async ({ documentId: raw, text }) => {
        const documentId = docIdOf(raw)
        if (!createdIds.has(documentId)) return NOT_OURS
        await docs.documents.batchUpdate({ documentId, requestBody: { requests: [{ insertText: { endOfSegmentLocation: {}, text: `\n${text}` } }] } })
        return 'appended'
      },
    }),

    // ── Sheets (read + create/append) ──
    sheet_read: tool({
      description: 'Read cell values from a Google Sheet. Range in A1 notation (e.g. "Sheet1!A1:D20").',
      inputSchema: z.object({ spreadsheetId: z.string(), range: z.string() }),
      execute: async ({ spreadsheetId, range }) => {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
        const rows = res.data.values ?? []
        return rows.length ? rows.map((r) => r.join('\t')).join('\n') : '(no values)'
      },
    }),
    sheet_append: tool({
      description: 'Append a row of values to a Google Sheet YOU created (sheet_create), by id or link. Other sheets are refused.',
      inputSchema: z.object({ spreadsheetId: z.string(), range: z.string().describe('e.g. "Sheet1!A1"'), values: z.array(z.string()) }),
      execute: async ({ spreadsheetId: raw, range, values }) => {
        const spreadsheetId = docIdOf(raw)
        if (!createdIds.has(spreadsheetId)) return NOT_OURS
        await sheets.spreadsheets.values.append({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values: [values] } })
        return 'row appended'
      },
    }),
    sheet_create: tool({
      description: 'Create a new Google Sheet with a title. Returns the spreadsheet id + link.',
      inputSchema: z.object({ title: z.string() }),
      execute: async ({ title }) => {
        const res = await sheets.spreadsheets.create({ requestBody: { properties: { title } } })
        const id = res.data.spreadsheetId!
        createdIds.add(id)
        return `created sheet "${title}" — https://docs.google.com/spreadsheets/d/${id}/edit`
      },
    }),
  }
}
