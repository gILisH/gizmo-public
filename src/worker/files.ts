import { extname } from 'node:path'

// How a file from Claude Code goes to WhatsApp. Shared by the worker (size cap) and Gizmo (send kind).
export const MAX_BYTES = 64 * 1024 * 1024 // WhatsApp media tops out around 100 MB; stay well under

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html',
  '.json': 'application/json', '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

// photo / video play inline in WhatsApp; everything else goes as a document.
export function kindOf(name: string): { as: 'image' | 'video' | 'document'; mimetype: string } {
  const ext = extname(name).toLowerCase()
  const mimetype = MIME[ext] ?? 'application/octet-stream'
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return { as: 'image', mimetype }
  if (['.mp4', '.mov'].includes(ext)) return { as: 'video', mimetype }
  return { as: 'document', mimetype }
}
