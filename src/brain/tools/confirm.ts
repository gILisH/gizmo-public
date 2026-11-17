import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'

// Approve or drop an action staged this chat by claude_code / schedule_task (see groups.ts
// makePostStager: a confirm in the turn that staged it is refused).
export function confirmTools(deps: BrainDeps, id: string, ctx: ToolCtx): ToolSet {
  const actions = deps.actions
  if (!actions || !ctx.isOwner || ctx.guest) return {}
  return {
    confirm_action: tool({
      description: 'Carry out the action you STAGED (a message to Claude Code, or a scheduled task) after the owner approved it in their reply ("yes"/"כן"/"go"). Never in the same turn you staged it.',
      inputSchema: z.object({}),
      execute: async () => actions.confirm(ctx.chatJid ?? id, ctx.turnId ?? ''),
    }),
    cancel_action: tool({
      description: 'Drop the staged action (Claude Code message / scheduled task) when the owner declines or changes their mind.',
      inputSchema: z.object({}),
      execute: async () => actions.cancel(ctx.chatJid ?? id),
    }),
  }
}
