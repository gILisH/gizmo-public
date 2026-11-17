import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { asRows, asText, renderFile, toCsv, type FileFormat, type StoredFile } from '../../files'

const format = z.enum(['csv', 'xlsx', 'pdf', 'txt'])

// Files Gizmo makes and keeps PER CHAT: a DM's files and a group's files are separate, so a
// group can never read a DM's spreadsheet. Stored as source (rows/text) → editable, and
// re-renderable in any format ("send the list as a PDF").
export function fileTools(deps: BrainDeps, id: string, ctx: ToolCtx): ToolSet {
  if (!deps.files || !deps.sendDocument) return {}
  const files = deps.files
  const chat = () => ctx.chatJid ?? id
  const send = async (f: StoredFile, as?: FileFormat, caption?: string) => {
    const { buffer, fileName, mimetype } = await renderFile(f, as)
    await deps.sendDocument!(chat(), buffer, fileName, mimetype, caption)
    return fileName
  }
  return {
    save_file: tool({
      description:
        'Create or UPDATE a file kept in this chat (csv / xlsx spreadsheet, pdf, txt) and send it here as a WhatsApp document. Same name = overwrite, so to edit: read_file, change it, save_file with the FULL new content. Tables (csv/xlsx) take `rows` (first row = headers); pdf/txt take `text`.',
      inputSchema: z.object({
        name: z.string().describe('file name without extension, e.g. "shopping list"'),
        format,
        rows: z.array(z.array(z.string())).optional().describe('table rows for csv/xlsx; first row = headers'),
        text: z.string().optional().describe('body for pdf/txt; one paragraph per line'),
        caption: z.string().optional(),
        send: z.boolean().optional().describe('false = save quietly without sending (default true)'),
      }),
      execute: async ({ name, format, rows, text, caption, send: doSend }) => {
        if (!rows?.length && !text) return 'nothing to save — give rows (csv/xlsx) or text (pdf/txt)'
        const f = files.save(chat(), { name, format, rows, text })
        if (doSend === false) return `saved "${f.name}" (${format}) without sending`
        return `saved and sent ${await send(f, format, caption)}`
      },
    }),
    list_files: tool({
      description: 'List the files kept in this chat (name, format, last update).',
      inputSchema: z.object({}),
      execute: async () => {
        const all = files.list(chat())
        if (!all.length) return 'no files in this chat yet'
        return all.map((f) => `${f.name} (${f.format}, ${f.rows ? `${f.rows.length} rows` : `${(f.text ?? '').length} chars`}, updated ${new Date(f.updatedAt).toISOString().slice(0, 16)})`).join('\n')
      },
    }),
    read_file: tool({
      description: 'Read a file kept in this chat, to answer about it or before editing it. Tables come back as CSV.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const f = files.get(chat(), name)
        if (!f) return `no file "${name}" in this chat — list_files shows what's here`
        const body = f.rows ? toCsv(asRows(f)).slice(1) : asText(f) // drop the BOM for the model
        return `${f.name} (${f.format}${f.rows ? ', table' : ''}):\n${body.slice(0, 20000)}${body.length > 20000 ? '\n…(truncated)' : ''}`
      },
    }),
    send_file: tool({
      description: 'Send a file kept in this chat again, optionally converted ("send the budget as xlsx/pdf"). Does not change the stored file.',
      inputSchema: z.object({ name: z.string(), as: format.optional().describe('convert to this format; default = its own'), caption: z.string().optional() }),
      execute: async ({ name, as, caption }) => {
        const f = files.get(chat(), name)
        if (!f) return `no file "${name}" in this chat — list_files shows what's here`
        return `sent ${await send(f, as, caption)}`
      },
    }),
    delete_file: tool({
      description: 'Delete a file kept in this chat. Only when someone asks to delete it.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => (files.remove(chat(), name) ? `deleted "${name}"` : `no file "${name}" in this chat`),
    }),
  }
}
