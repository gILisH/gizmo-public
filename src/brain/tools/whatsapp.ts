import { tool } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'

// Native WhatsApp message primitives: poll, reaction, location pin, contact card, quote-reply,
// and editing/deleting Gizmo's own last message. All act on the CURRENT chat; react/quote target
// the user's latest message and edit/delete target Gizmo's own — the transport tracks those keys,
// so the model never handles message ids. Each tool appears only if its dep is wired.
export function whatsappTools(deps: BrainDeps, id: string, ctx: ToolCtx) {
  const chat = () => ctx.chatJid ?? id
  return {
    ...(deps.sendPoll
      ? {
          send_poll: tool({
            description:
              'Send a WhatsApp poll to this chat — everyone sees the running tally natively. Use for group decisions: "where for dinner?", "who\'s coming Friday?". Give a clear question + 2–12 short options.',
            inputSchema: z.object({
              question: z.string().describe('the poll question'),
              options: z.array(z.string()).min(2).max(12).describe('2–12 answer options'),
            }),
            execute: async ({ question, options }) => {
              await deps.sendPoll!(chat(), question, options)
              return 'poll sent'
            },
          }),
        }
      : {}),
    ...(deps.react
      ? {
          react: tool({
            description:
              'React to the user\'s latest message with a single emoji ("❤️", "👍", "😂", "🔥") — this IS your entire reply. Use it INSTEAD of a text message when an ack is all that\'s needed ("like this", "👍 that"). Do NOT also send text after reacting. If the user also needs a worded answer, reply with text instead of reacting. Pass an empty string to remove your reaction.',
            inputSchema: z.object({ emoji: z.string().describe('one emoji, or "" to clear') }),
            execute: async ({ emoji }) => {
              await deps.react!(chat(), emoji)
              return 'reacted'
            },
          }),
        }
      : {}),
    ...(deps.sendLocation
      ? {
          send_location: tool({
            description:
              'Drop a WhatsApp location pin in this chat. EASIEST: just pass `place` (a name or address, e.g. "Capybara Cafe, Phuket") and I look up the coordinates myself — do NOT try to find lat/lng yourself. Only pass latitude+longitude if you genuinely already have exact coordinates.',
            inputSchema: z.object({
              place: z.string().optional().describe('place name or address to look up (preferred)'),
              latitude: z.number().optional(),
              longitude: z.number().optional(),
              name: z.string().optional().describe('label shown on the pin'),
            }),
            execute: async ({ place, latitude, longitude, name }) => {
              let lat = latitude
              let lng = longitude
              let label = name
              if ((lat == null || lng == null) && place && deps.geocode) {
                const g = await deps.geocode(place)
                if (!g) return `couldn't find "${place}" on the map — tell them so and ask for a more specific name or the address`
                lat = g.lat
                lng = g.lng
                label = label ?? place
              }
              if (lat == null || lng == null) return 'need a place name (preferred) or exact coordinates to drop a pin'
              await deps.sendLocation!(chat(), lat, lng, label)
              return `location sent${label ? ` (${label})` : ''}`
            },
          }),
        }
      : {}),
    ...(deps.sendContact
      ? {
          send_contact: tool({
            description:
              'Send a tappable WhatsApp contact card. Use when sharing someone\'s number ("send me the plumber\'s number") — pull the name + phone from history/memory.',
            inputSchema: z.object({
              name: z.string().describe('contact display name'),
              phone: z.string().describe('phone number, international format preferred'),
            }),
            execute: async ({ name, phone }) => {
              await deps.sendContact!(chat(), name, phone)
              return 'contact sent'
            },
          }),
        }
      : {}),
    ...(deps.replyQuote
      ? {
          reply_quote: tool({
            description:
              'Reply with text that QUOTES the user\'s latest message. Use in a busy group to make clear which message you\'re answering. For a normal reply just answer directly — don\'t quote every time.',
            inputSchema: z.object({ text: z.string() }),
            execute: async ({ text }) => {
              await deps.replyQuote!(chat(), text)
              return 'replied (quoted)'
            },
          }),
        }
      : {}),
    ...(deps.editLastMessage
      ? {
          edit_message: tool({
            description:
              'Edit YOUR OWN most recent message in this chat (fix a typo, correct a fact) instead of sending a follow-up. Only works on your last message.',
            inputSchema: z.object({ text: z.string().describe('the corrected full message') }),
            execute: async ({ text }) => {
              await deps.editLastMessage!(chat(), text)
              return 'edited'
            },
          }),
        }
      : {}),
    ...(deps.deleteLastMessage
      ? {
          delete_message: tool({
            description:
              'Delete (retract) YOUR OWN most recent message in this chat — use when you said something wrong and want it gone. Only works on your last message.',
            inputSchema: z.object({}),
            execute: async () => {
              await deps.deleteLastMessage!(chat())
              return 'deleted'
            },
          }),
        }
      : {}),
  }
}
