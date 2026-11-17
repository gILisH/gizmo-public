import type { ToolSet } from 'ai'
import type { BrainDeps, ToolCtx } from '../types'
import { historyTools } from './history'
import { schedulingTools } from './scheduling'
import { memoryTools } from './memory'
import { webTools } from './web'
import { imageTools } from './images'
import { peopleTools } from './people'
import { chatTools } from './chat'
import { groupTools } from './groups'
import { settingsTools } from './settings'
import { whatsappTools } from './whatsapp'
import { fileTools } from './files'
import { selfTools } from './self'
import { ledgerTools } from './ledger'
import { confirmTools } from './confirm'

// Compose the per-domain tool modules into the tool set the brain hands the model.
// Every tool is closed over the bound speaker `id` and per-turn `ctx` (owner/group/scope):
// owner-gating and ACL live INSIDE each module, never in the model's hands. Adding a
// feature = add a module and one spread line here.
export function buildTools(deps: BrainDeps, id: string, ctx: ToolCtx = {}): ToolSet {
  const all: ToolSet = {
    ...historyTools(deps, id, ctx),
    ...schedulingTools(deps, id, ctx),
    ...memoryTools(deps, id, ctx),
    ...webTools(deps, id, ctx),
    ...imageTools(deps, id, ctx),
    ...peopleTools(deps, id, ctx),
    ...chatTools(deps, id, ctx),
    ...settingsTools(deps, id, ctx), // before groupTools: keeps the tool order the model saw before the split
    ...groupTools(deps, id, ctx),
    ...whatsappTools(deps, id, ctx),
    ...fileTools(deps, id, ctx),
    ...selfTools(deps, id, ctx),
    ...ledgerTools(deps, id, ctx),
    ...confirmTools(deps, id, ctx),
    // Speaker-scoped extras (e.g. Google), wired by the composition root so owner-only
    // integrations reach only the right person.
    ...(deps.extraTools ? deps.extraTools({ id, isOwner: ctx.isOwner ?? false, inGroup: ctx.inGroup ?? false, fromSandbox: Boolean(ctx.fromSandbox) }) : {}),
  }
  // The worker is an internet-facing agent that can be prompt-injected: its questions get an
  // ALLOWLIST of read-only history tools — anything new is denied until it's listed here.
  if (ctx.fromSandbox) return Object.fromEntries(Object.entries(all).filter(([name]) => SANDBOX_TOOLS.has(name)))
  return all
}

export const SANDBOX_TOOLS = new Set(['searchHistory', 'recentMessages', 'oldest_messages', 'messagesByDate', 'fetch_earlier_messages'])
