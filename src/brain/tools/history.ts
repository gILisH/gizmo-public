import { tool } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { parseDayRange, fmtMsg } from '../format'

// Read the WhatsApp corpus: relevance search, recency, oldest, by-date, paging, and the
// owner's self-chat. ACL scoping (ctx.chatScope) is applied here + in the store, never by
// the model.
export function historyTools(deps: BrainDeps, id: string, ctx: ToolCtx) {
  const chatScope = ctx.chatScope
  return {
    searchHistory: tool({
      description:
        'Search the WhatsApp message history for relevant past messages. Use for any question about what was said, when, or by whom. Optional: `from` (sender name contains), `after`/`before` (YYYY-MM-DD), `sort` — results are newest-first among matches by default (what people usually want: the LATEST mention). Pass "relevance" only when they want the message MOST ABOUT a topic regardless of when ("find the message where we planned the trip").',
      inputSchema: z.object({
        query: z.string().describe('what to search for (any language)'),
        from: z.string().optional().describe('filter to a sender whose name contains this'),
        after: z.string().optional().describe('only messages on/after this date (YYYY-MM-DD)'),
        before: z.string().optional().describe('only messages on/before this date (YYYY-MM-DD)'),
        sort: z.enum(['relevance', 'recent']).optional().describe('"recent" = newest matches first; "relevance" (default) = best topical match first'),
      }),
      execute: async ({ query, from, after, before, sort }) => {
        const hits = await deps.search(query, {
          limit: 12,
          from,
          after: after ? parseDayRange(after, undefined, ctx.tz)[0] : undefined,
          before: before ? parseDayRange(before, undefined, ctx.tz)[1] : undefined,
          chatScope,
          sort,
        })
        if (hits.length === 0) return 'no matching messages found'
        return hits.map((m) => fmtMsg(m, ctx.tz)).join('\n')
      },
    }),
    recentMessages: tool({
      description:
        'Get the most recent messages in chronological order (newest first). Use for ANY time/recency question — "what did I last say", "latest message", "recent chats", "when" — because searchHistory ranks by relevance, NOT time.',
      inputSchema: z.object({
        limit: z.number().max(20).describe('how many recent messages (default 10)'),
        onlyMine: z.boolean().optional().describe('true = only messages the owner sent'),
      }),
      execute: async ({ limit, onlyMine }) => {
        const msgs = deps.recent(limit || 10, { fromMe: onlyMine, chatScope })
        if (msgs.length === 0) return 'no messages'
        return msgs.map((m) => fmtMsg(m, ctx.tz)).join('\n')
      },
    }),
    oldest_messages: tool({
      description:
        'Get the OLDEST messages in the whole history (chronological, earliest first). Use for "what\'s the earliest/oldest message you have", "how far back does your history go", or questions about the beginning of the archive. History goes back years, NOT just to our first chat.',
      inputSchema: z.object({ limit: z.number().max(20).describe('how many of the oldest messages (default 10)') }),
      execute: async ({ limit }) => {
        const msgs = deps.oldest(limit || 10, { chatScope })
        if (msgs.length === 0) return 'no messages'
        return msgs.map((m) => fmtMsg(m, ctx.tz)).join('\n')
      },
    }),
    messagesByDate: tool({
      description:
        'Get messages from a specific date or date range, in chronological order. Use for "what did we talk about on <date>", "messages from last week", "between X and Y". Dates are YYYY-MM-DD.',
      inputSchema: z.object({
        from: z.string().describe('start date YYYY-MM-DD'),
        to: z.string().optional().describe('end date YYYY-MM-DD (omit for a single day)'),
        limit: z.number().max(50).optional().describe('max messages (default 30)'),
      }),
      execute: async ({ from, to, limit }) => {
        const [fromTs, toTs] = parseDayRange(from, to, ctx.tz)
        const msgs = deps.range(fromTs, toTs, limit || 30, { chatScope })
        if (msgs.length === 0) return `no messages between ${from} and ${to ?? from}`
        return msgs.map((m) => fmtMsg(m, ctx.tz)).join('\n')
      },
    }),
    fetch_earlier_messages: tool({
      description:
        'Page further back through THIS chat by position (deterministic — not a search). You already see the most recent turns; use this to pull older ones in order. skip = how many of the most-recent messages to skip (0 = newest), limit = how many to return. E.g. you have the last 15 and need more → skip:15, limit:25 returns messages 16–40 back.',
      inputSchema: z.object({
        skip: z.number().int().min(0).describe('most-recent messages to skip (0 = newest)'),
        limit: z.number().int().min(1).max(50).describe('how many to return'),
      }),
      execute: async ({ skip, limit }) => {
        const msgs = deps.pageChat(ctx.chatJid ?? id, skip, Math.min(limit, 50))
        return msgs.length ? msgs.map((m) => fmtMsg(m, ctx.tz)).join('\n') : 'no earlier messages in this chat'
      },
    }),
    // Owner-only: the "Message yourself" chat IS in the corpus (synced via the owner's
    // read-only socket), stored under the owner's own phone jid — a different chat than
    // this DM. The enumerate-a-chat primitive (SELECT … WHERE chat = self). DM only: it reads
    // another chat, so in a group it would put the owner's notes in front of everyone.
    ...(ctx.isOwner && !ctx.inGroup
      ? {
          read_self_chat: tool({
            description:
              'Read the owner\'s OWN "Message yourself" chat — the notes and links they saved to themselves (NOT groups or chats with other people). Use for "the links I sent myself", "my saved links/notes", "what did I bookmark". Set links_only:true to get only the messages with a URL — best for "categorize the links I sent myself". Returns them oldest→newest. Only ~recent history is synced, so it may not go back a full year.',
            inputSchema: z.object({
              limit: z.number().int().min(1).max(300).optional().describe('max messages (default 200)'),
              links_only: z.boolean().optional().describe('true = only messages containing a URL'),
            }),
            execute: async ({ limit, links_only }) => {
              const selfJid = `${id}@s.whatsapp.net` // self-chat is stored under the owner's phone jid
              let msgs = deps.pageChat(selfJid, 0, Math.min(limit ?? 200, 300))
              if (links_only) msgs = msgs.filter((m) => /https?:\/\//i.test(m.text))
              msgs = [...msgs].reverse() // pageChat is newest-first; present oldest→newest for categorizing
              return msgs.length ? msgs.map((m) => fmtMsg(m, ctx.tz)).join('\n') : 'no messages found in your self-chat (only recent history is synced)'
            },
          }),
        }
      : {}),
  }
}
