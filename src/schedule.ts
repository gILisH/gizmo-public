import type { Store } from './store/types'
import type { InboundMessage } from './transport/types'
import { isGroupJid } from './access/jid'

// Recurrence for scheduled reminders/tasks. Next fire = fromTs + a fixed interval.
// ponytail: interval-based (not cron) — covers hourly/daily/weekly, which is ~all a
// family wants. Computed from the fire time, so a daily task can drift by up to the
// downtime if the bot was offline; add local-time cron only if that ever matters.
const INTERVALS: Record<string, number> = { hourly: 3600, daily: 86400, weekly: 604800 }

export function nextDue(recurrence: string | null | undefined, fromTs: number): number | null {
  const step = recurrence ? INTERVALS[recurrence] : undefined
  return step ? fromTs + step : null
}

type ReminderStore = Pick<Store, 'dueReminders' | 'markFired' | 'rescheduleReminder'>

// Fire every due reminder in its OWN stored chat (never ambient identity). Each one is
// claimed (rescheduled or marked fired) BEFORE it runs: a slow task can't be picked up
// again by the next tick, and a failing send can't block the ones behind it forever.
// ponytail: at-most-once — a send that fails is logged, not retried; add bounded retries if that bites.
export async function fireDueReminders(deps: {
  store: ReminderStore
  respond: (m: InboundMessage) => Promise<void>
  send: (m: { chatJid: string; text: string }) => Promise<unknown>
  now: number
}): Promise<void> {
  const { store, respond, send, now } = deps
  for (const r of store.dueReminders(now)) {
    const next = nextDue(r.recurrence, now)
    if (next) store.rescheduleReminder(r.id, next)
    else store.markFired(r.id)
    try {
      if (r.instruction) {
        // Scheduled TASK: replay the instruction through the normal reply pipeline (as
        // if the owner typed it in that chat) — inherits tools, ACL, budget, voice.
        await respond({
          id: `sched:${r.id}:${now}`, chatJid: r.chatJid, senderJid: `${r.ownerId}@s.whatsapp.net`,
          text: r.instruction, ts: now, fromMe: false, isGroup: isGroupJid(r.chatJid), mentionsMe: true,
        })
      } else {
        await send({ chatJid: r.chatJid, text: `⏰ ${r.text}` }) // fixed reminder — no LLM
      }
    } catch (err) {
      console.error(`reminder ${r.id} failed:`, (err as Error).message)
    }
  }
}

// One tick at a time: a tick still running (a slow scheduled task) makes the next one skip.
export function nonOverlapping(fn: () => Promise<void>): () => Promise<void> {
  let running = false
  return async () => {
    if (running) return
    running = true
    try { await fn() } finally { running = false }
  }
}
