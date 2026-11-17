import { tool } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'

// Durable facts. remember() is bound to the current speaker (no destination arg — the
// model can't choose whose memory to write). remember_group/revise_family_memory write
// the group's SHARED memory and exist only in a group.
export function memoryTools(deps: BrainDeps, id: string, ctx: ToolCtx) {
  return {
    // Guest group: only that group's own shared memory — never facts about a person.
    ...(ctx.guest ? {} : { remember: tool({
      description:
        'Save a durable fact about the person you are talking to (a stable preference, ownership, or lasting decision). Do NOT save transient chatter. NEVER for pocket money (kids\' balances, purchases, gifts) — that goes in the ledger (ledger_add).',
      inputSchema: z.object({ fact: z.string().describe('the fact to remember') }),
      execute: async ({ fact }) => {
        deps.memory.addFact(id, fact) // bound to the current speaker — no destination arg
        return 'saved'
      },
    }) }),
    // Shared family memory — only in a group. Facts EVERYONE benefits from (relationships,
    // kids, birthdays, addresses), not personal facts about one speaker (use `remember`).
    ...(ctx.inGroup && ctx.chatJid
      ? {
          remember_group: tool({
            description:
              'Save a NEW durable shared fact about this family/group — relationships, kids, ages, birthdays, where people live. Anyone in the group may teach you a fact. JUDGE FIRST: only save something you genuinely believe is true. Do NOT save jokes, sarcasm, teasing or insults (e.g. "Savta is 120", "Omer is an alien"). If a claim is implausible or you are not sure it is serious, do NOT save it — ask an owner (Dan or Alex) to confirm first. NOT for one person\'s private preference (use remember). NOT for pocket money — that goes in the ledger.',
            inputSchema: z.object({ fact: z.string().describe('the shared family fact to remember') }),
            execute: async ({ fact }) => {
              deps.memory.addGroupFact(ctx.chatJid!, fact)
              return 'noted' // acknowledge naturally to the user; do NOT recite the fact or mention "memory"
            },
          }),
          revise_family_memory: tool({
            description:
              'CORRECT or remove existing shared family facts. Pass the COMPLETE updated list (keep every fact that is still true, with the fix applied, and drop only what is wrong). Same judgment as remember_group — ignore jokes/sarcasm; if unsure a correction is serious, ask an owner (Dan or Alex) to confirm before revising. The previous version is backed up automatically.',
            inputSchema: z.object({ facts: z.array(z.string()).describe('the full corrected list of family facts') }),
            execute: async ({ facts }) => {
              deps.memory.writeGroupFacts(ctx.chatJid!, facts)
              return 'noted'
            },
          }),
        }
      : {}),
  }
}
