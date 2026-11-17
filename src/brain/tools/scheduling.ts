import { tool } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { isValidTz, parseWhen, localStamp, HOME_TZ } from '../format'

// Time-based sends. set_reminder fires a FIXED text (no thinking). schedule_task runs an
// instruction through the brain at fire time (fresh info/tools) and is owner-only.
export function schedulingTools(deps: BrainDeps, id: string, ctx: ToolCtx) {
  return {
    ...(deps.setChatTz
      ? {
          set_timezone: tool({
            description:
              `Set THIS chat's timezone when the people here say they're somewhere else ("we're in Boston", "landed in NYC") — then "today", "tomorrow", times and reminders follow that place. Pass an IANA zone like "America/New_York", or "home" when they're back (home is ${HOME_TZ}).`,
            inputSchema: z.object({ tz: z.string().describe('IANA timezone, e.g. "America/New_York", or "home"') }),
            execute: async ({ tz }) => {
              const home = tz.trim().toLowerCase() === 'home' || tz === HOME_TZ
              if (!home && !isValidTz(tz)) return `"${tz}" isn't a timezone — use an IANA name like "America/New_York"`
              deps.setChatTz!(ctx.chatJid ?? id, home ? null : tz)
              return home ? `this chat is back on home time (${HOME_TZ})` : `this chat is now on ${tz} time`
            },
          }),
        }
      : {}),
    set_reminder: tool({
      description:
        'Set a FIXED reminder — the same text is sent at the time, no thinking needed (e.g. "drink water", "call mum"). Give an ISO 8601 datetime in the chat local time (resolve "tomorrow"/"in 2h"/"Friday 8pm" from the current date in your context). For something that repeats, pass repeat. Use this (NOT schedule_task) whenever the message is known in advance — it costs nothing to fire.',
      inputSchema: z.object({
        text: z.string().describe('the exact reminder message to send'),
        whenISO: z.string().describe('ISO 8601 datetime of the first (or only) fire'),
        repeat: z.enum(['hourly', 'daily', 'weekly']).optional().describe('omit for one-shot'),
      }),
      execute: async ({ text, whenISO, repeat }) => {
        const dueTs = parseWhen(whenISO, ctx.tz)
        if (!dueTs || Number.isNaN(dueTs)) return 'invalid time — give an ISO datetime'
        deps.setReminder({ chatJid: ctx.chatJid ?? id, ownerId: id, text, dueTs, recurrence: repeat })
        return `reminder set for ${whenISO}${repeat ? ` (repeats ${repeat})` : ''}`
      },
    }),
    // Pending reminders/tasks in THIS chat only. Anyone may cancel what they set; an owner
    // may cancel any of them (that's how a planted schedule gets found and removed).
    ...(deps.listReminders && deps.cancelReminder
      ? {
          list_reminders: tool({
            description: 'List the reminders and scheduled tasks still pending in THIS chat (id, next time, repeat, what it sends or does). Use before cancel_reminder, or when asked "what reminders do I have".',
            inputSchema: z.object({}),
            execute: async () => {
              const rows = deps.listReminders!(ctx.chatJid ?? id)
              if (!rows.length) return 'no pending reminders or scheduled tasks in this chat'
              return rows
                .map((r) => `#${r.id} ${localStamp(r.dueTs, ctx.tz)}${r.recurrence ? ` (repeats ${r.recurrence})` : ''} — ${r.instruction ? `task: ${r.instruction}` : `reminder: ${r.text}`}${r.ownerId === id ? '' : ` [set by ${r.ownerId}]`}`)
                .join('\n')
            },
          }),
          cancel_reminder: tool({
            description: 'Cancel a pending reminder or scheduled task in THIS chat by its id (from list_reminders). A repeating one stops for good.',
            inputSchema: z.object({ id: z.number().int().describe('the #id from list_reminders') }),
            execute: async ({ id: rid }) =>
              deps.cancelReminder!(rid, ctx.chatJid ?? id, ctx.isOwner ? undefined : id)
                ? `cancelled #${rid}`
                : `no pending reminder #${rid} here that you can cancel — check list_reminders`,
          }),
        }
      : {}),
    // Owner-only: the instruction is run through the brain (with tools) at fire time, so
    // the message is generated fresh each time. It replays as the owner with all his tools,
    // so it is STAGED: an instruction planted in text he forwarded can't schedule itself.
    ...(ctx.isOwner && deps.actions
      ? {
          schedule_task: tool({
            description:
              'Schedule an ACTION to run at a time — use when the message can\'t be written in advance because it needs fresh info or a tool (e.g. "the weather in Paris", "a summary of the family group this week", "today\'s news"). The instruction is run through you at fire time and the result is sent. For a fixed message that never changes, use set_reminder instead (cheaper — no thinking). This STAGES the task: tell the owner what will run and when, and schedule it only after they say yes (confirm_action).',
            inputSchema: z.object({
              instruction: z.string().describe('what to do at fire time, phrased as a task to yourself (e.g. "get the weather in Paris and send it")'),
              whenISO: z.string().describe('ISO 8601 datetime of the first (or only) run'),
              repeat: z.enum(['hourly', 'daily', 'weekly']).optional().describe('omit for one-shot'),
            }),
            execute: async ({ instruction, whenISO, repeat }) => {
              const dueTs = parseWhen(whenISO, ctx.tz)
              if (!dueTs || Number.isNaN(dueTs)) return 'invalid time — give an ISO datetime'
              const when = `${whenISO}${repeat ? ` (repeats ${repeat})` : ''}`
              deps.actions!.stage(ctx.chatJid ?? id, `scheduled task "${instruction}"`, async () => {
                deps.setReminder({ chatJid: ctx.chatJid ?? id, ownerId: id, dueTs, instruction, recurrence: repeat })
                return `task scheduled for ${when}`
              }, ctx.turnId ?? '')
              return `STAGED, not scheduled yet: "${instruction}" at ${when}. Ask the owner to approve; only after they say yes call confirm_action; if no, cancel_action.`
            },
          }),
        }
      : {}),
  }
}
