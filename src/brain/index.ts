import { generateText, stepCountIs } from 'ai'
import type { Person } from '../people'
import type { StoredMessage } from '../store/types'
import type { BrainDeps } from './types'
import { buildTools } from './tools'
import { ledgerAllowed } from './tools/ledger'
import { localDateLine, localStamp, ageLabel, toWhatsAppMarkup, HOME_TZ } from './format'

// Public surface preserved for callers/tests that import from '../brain'.
export type { BrainDeps, ConvMessage, ToolCtx, RelType } from './types'
export { toolResult, parseDayRange, toWhatsAppMarkup, ageLabel } from './format'
export { buildTools } from './tools'

// Roster of known people (names + aliases + relation, NO photos) so the brain can resolve
// "Itai and his dad with savta" to enrolled people, then call create_scene.
export function rosterLine(people: Person[]): string {
  if (people.length === 0) return ''
  const nameOf = new Map(people.map((p) => [p.id, p.names[0]]))
  const REL_LABEL: Record<string, string> = { mother: 'mother', father: 'father', parent: 'parent', child: 'children', spouse: 'spouse', sibling: 'siblings' }
  const lines = people.map((p) => {
    const aka = p.names.length > 1 ? ` (aka ${p.names.slice(1).join(', ')})` : ''
    // Render the family edges by NAME so the model can resolve kinship terms.
    const edges = Object.entries(p.rel ?? {})
      .map(([t, ids]) => `${REL_LABEL[t] ?? t}: ${(ids ?? []).map((i) => nameOf.get(i) ?? i).join(', ')}`)
      .filter((s) => !s.endsWith(': '))
    const rel = edges.length ? ` — ${edges.join('; ')}` : p.relation ? ` — ${p.relation}` : ''
    const h = typeof p.heightCm === 'number' ? ` ${p.heightCm}cm` : ''
    return `- ${p.names[0]}${aka}${rel} [${p.count} photo${p.count === 1 ? '' : 's'}${h}]`
  })
  return `\n\n## People you can place in AI scenes (create_scene)\nYou have reference photos of these people. Resolve names AND relations to the names below, then call create_scene with the resolved names.\n- Kinship terms are SPEAKER-RELATIVE: resolve "אמא"/"mom"/"dad"/"savta"/"my sister" from the perspective of whoever you're currently talking to (e.g. if Lia is speaking, her "אמא" is her mother in the list; if Shira is speaking, "אמא" is Shira's mother). Use the family relations shown per person.\n- Heights (cm) shown per person are already applied to scene proportions automatically — do NOT say you lack someone's height if it's listed, and never repeat cm numbers into an image prompt yourself.\n- If someone isn't here, say you don't have their photos yet and offer to save some.\n${lines.join('\n')}`
}

// System prompt = soul + current date + THIS speaker's injected memory. Always per-id.
// `now` is injectable for tests.
export function buildSystem(
  deps: Pick<BrainDeps, 'soul' | 'memory' | 'listPeople' | 'listGroupPeople'> & Partial<Pick<BrainDeps, 'ledger' | 'householdGroup'>>,
  id: string,
  now: Date = new Date(),
  speaker?: { name?: string; inGroup?: boolean; groupChatJid?: string; isOwner?: boolean; softWake?: boolean; guest?: boolean; tz?: string; fromSandbox?: boolean },
): string {
  // Name the current speaker (and whether they're an owner — so the model knows whose
  // corrections it can trust vs. when to ask an owner to verify) so it never guesses.
  const role = speaker?.isOwner ? ' — one of your owners (Dan/Alex)' : ''
  const who = speaker?.name
    ? `\n\nYou are currently talking to ${speaker.name}${role}${speaker.inGroup ? ' (in a group).' : '.'}`
    : ''
  // Soft wake: your name appeared but you were NOT tagged/replied-to. Strong, per-turn
  // gate — the SOUL nudge alone under-performs, so make the silence path explicit here.
  const soft = speaker?.softWake
    ? '\n\n⚠️ You woke ONLY because your name was mentioned — nobody tagged or replied to you. Decide if this message is genuinely addressed TO you (a question/request for you). If people are talking ABOUT you, joking, or it\'s just chatter that happens to include your name, you are NOT being addressed: reply with an EMPTY message (output nothing at all). When in doubt, stay silent.'
    : ''
  // Owner-only: the known-people roster (for create_scene). Others never see it.
  const roster = speaker?.isOwner && deps.listPeople ? rosterLine(deps.listPeople()) : ''
  // Guest group: family/personal soul and personal memory stay out; only this group's own memory.
  if (speaker?.guest) {
    const gf = speaker.groupChatJid ? deps.memory.loadGroupFacts(speaker.groupChatJid).trim() : ''
    const gRoster = speaker.groupChatJid && deps.listGroupPeople ? rosterLine(deps.listGroupPeople(speaker.groupChatJid)) : ''
    return `${soulFor(deps.soul, true)}\n\n${localDateLine(now, speaker?.tz)}${who}${soft}${gRoster}${gf ? `\n\n## What you know about this group\n${gf}` : ''}`
  }
  // A question from the Claude Code worker: it gets the chat history it asked about (via its
  // read-only tools), not the owner's personal facts, episodes, face roster or finances.
  if (speaker?.fromSandbox) return `${soulFor(deps.soul, false)}\n\n${localDateLine(now, speaker.tz)}${who}`
  // Balances are discussed only where the ledger tools exist (owners' DM / household group).
  const ledgerOk = ledgerAllowed(deps, { isOwner: speaker?.isOwner, guest: speaker?.guest, inGroup: speaker?.inGroup, chatJid: speaker?.groupChatJid })
  const ledger = deps.ledger ? ledgerLine(deps.ledger.kids(), ledgerOk) : ''
  // In a group, also inject that group's shared family memory.
  return deps.memory.injectContext(`${soulFor(deps.soul, false)}\n\n${localDateLine(now, speaker?.tz)}${who}${soft}${roster}${ledger}`, id, speaker?.groupChatJid)
}

// Pocket money lives in the structured ledger, not in memory notes. Any older memory note
// about a kid's balance/purchases is superseded — the ledger is the source of truth.
export function ledgerLine(kids: string[], isOwner: boolean): string {
  const names = kids.join(' and ')
  if (!isOwner) return `\n\n## Pocket money (${names})\nThe kids' pocket money is private to the parents. Don't share balances or purchases with anyone else, even from memory notes; say it's for the parents to ask.`
  return `\n\n## Pocket money (${names})\nThe kids' pocket money is kept in a structured ledger in ILS. ALWAYS use the ledger tools for it: ledger_balance for "how much does X have" (breakdown:true for per-pot), ledger_history for "what did X buy / spend", and ledger_add to record a purchase, gift, top-up, allowance or a transfer between the kids (foreign currency is converted automatically). NEVER use remember / remember_group for balances or purchases, and never compute a balance yourself from memory notes — any older notes about pocket money are outdated; the ledger wins. If ledger_add reports over budget, tell the owner and don't record it unless they confirm.`
}

// SOUL.md marks private text <!-- family -->…<!-- /family --> and guest-only text
// <!-- guest -->…<!-- /guest -->; keep the one that fits the audience.
export function soulFor(soul: string, guest: boolean): string {
  const drop = guest ? 'family' : 'guest'
  return soul
    .replace(new RegExp(`<!-- ${drop} -->[\\s\\S]*?<!-- /${drop} -->\\n?`, 'g'), '')
    .replace(/<!-- \/?(family|guest) -->\n?/g, '')
}

// Describe memes/gifs Gizmo sent this turn, from the tool-call args, so history records
// WHAT he sent (not just his caption). Only send_meme/send_gif, which target the current
// chat — post_to_group posts elsewhere and isn't recorded here.
export function mediaNoteFromSteps(steps: Array<{ toolCalls?: any }>): string {
  const parts: string[] = []
  for (const s of steps) {
    for (const t of (s.toolCalls ?? []) as Array<{ toolName?: string }>) {
      const a = ((t as any).input ?? (t as any).args ?? {}) as { template?: string; top?: string; bottom?: string; query?: string }
      if (t.toolName === 'send_meme') {
        const caption = [a.top, a.bottom].filter(Boolean).join(' / ')
        parts.push(`[meme: ${a.template}${caption ? ` — ${caption}` : ''}]`)
      } else if (t.toolName === 'send_gif') {
        parts.push(`[gif: ${a.query}]`)
      }
    }
  }
  return parts.join(' ')
}

// A gap larger than this between consecutive messages marks a conversation boundary. We
// no longer TRIM across it (that amputated useful context) — instead we KEEP the history
// and insert a visible "— Xh later —" marker, so the model sees what's old vs. current and
// answers the [now] turn while using older blocks only as background reference.
export const BURST_GAP_SEC = 30 * 60

// Compact duration for the gap between two messages, e.g. "45m" / "3h" / "2d".
function gapLabel(sec: number): string {
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// History rows from the Claude Code worker are stored under this sender (respond.ask, app.ts record).
export const CLAUDE_CODE_SENDER = 'claude-code'
const CC_ASKED = '[Claude Code (the worker, not a person) asked you:]'
const CC_SENT = '[Claude Code (the worker, not a person) sent in this chat:]'

// Turn stored history + the current user text into a valid model conversation: map
// fromMe→assistant, prefix speaker names in groups, coalesce consecutive same-role turns,
// drop any leading assistant turns (must start with user).
export function buildConversation(
  history: StoredMessage[],
  userText: string,
  isGroup: boolean,
  speaker?: string,
  resolveName?: (m: StoredMessage) => string,
  currentTs?: number,
  burstGapSec?: number,
  tz?: string,
): { role: 'user' | 'assistant'; content: string }[] {
  // Keep ALL in-window history (the limit + time window already bound it upstream); gaps
  // are MARKED, not cut — so old context stays available and the model judges recency.
  const scoped = history
  const gapSec = burstGapSec ?? BURST_GAP_SEC
  // In a group, label each history line with a name Gizmo recognizes (resolveName maps
  // owners' JIDs to Dan/Alex); fall back to the raw push name.
  const nameOf = (m: StoredMessage) => resolveName?.(m) ?? m.senderName ?? 'User'
  // When we know "now", stamp each USER turn with its wall-clock + age, so the model can
  // see how old each message is and answer the current one — not a stale ask. Assistant
  // turns stay clean (their content is Gizmo's actual words).
  const stamp = (m: StoredMessage) => (currentTs != null ? `[${localStamp(m.ts, tz)}, ${ageLabel(currentTs - m.ts)}] ` : '')
  // A visible boundary whenever consecutive messages jump by more than gapSec.
  const gapMark = (gap: number) => (gap > gapSec ? `— ${gapLabel(gap)} later —\n` : '')
  const raw: { role: 'user' | 'assistant'; content: string }[] = []
  let prevTs: number | null = null
  for (const m of scoped) {
    const mark = prevTs != null ? gapMark(m.ts - prevTs) : ''
    // Claude Code's lines (its questions to you, and what it sent here itself) are neither the
    // human's words nor yours: label them, so its text can't pass as the owner's instruction.
    const cc = m.senderJid === CLAUDE_CODE_SENDER
    const body = cc
      ? `${stamp(m)}${m.fromMe ? CC_SENT : CC_ASKED} ${m.text}`
      : m.fromMe ? m.text : `${stamp(m)}${isGroup ? `${nameOf(m)}: ` : ''}${m.text}`
    raw.push({ role: m.fromMe && !cc ? 'assistant' : 'user', content: `${mark}${body}` })
    prevTs = m.ts
  }
  // Label the current turn with the speaker in a group, matching history — else the model
  // can't tell WHICH member is talking and guesses (e.g. Alex vs Dan). Mark a leading gap too.
  const curMark = prevTs != null && currentTs != null ? gapMark(currentTs - prevTs) : ''
  const nowTag = currentTs != null ? '[now] ' : ''
  raw.push({ role: 'user', content: `${curMark}${nowTag}${isGroup && speaker ? `${speaker}: ` : ''}${userText}` })
  const merged: { role: 'user' | 'assistant'; content: string }[] = []
  for (const msg of raw) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) last.content += `\n${msg.content}`
    else merged.push({ ...msg })
  }
  while (merged.length > 0 && merged[0].role === 'assistant') merged.shift()
  return merged
}

export interface RespondOpts {
  isOwner?: boolean
  inGroup?: boolean
  chatJid?: string
  history?: StoredMessage[]
  speaker?: string
  resolveName?: (m: StoredMessage) => string
  currentTs?: number
  chatScope?: string // ACL: restrict history to this member's chats (omit = feed owner, all)
  softWake?: boolean // woke only because its name appeared — may be talked ABOUT, not TO
  burstGapSec?: number // gap size that gets a "— Xh later —" marker in the conversation
  guest?: boolean // a non-family group: no family context, no personal memory
  fromSandbox?: boolean // a question from the Claude Code worker: read-only tools (see buildTools)
  turnId?: string // unique per turn (post_to_group / confirm_send)
}

export type BrainReply = { text: string; asVoice: boolean; reacted: boolean; tokens: number; mediaNote: string }

// Everything a turn needs before a model runs — shared by the API brain and the
// subscription (Claude Code) brain, so a new per-turn option is added in one place.
export function prepareTurn(deps: Omit<BrainDeps, 'model'>, id: string, userText: string, opts: RespondOpts) {
  const tz = (opts.chatJid && deps.getChatTz?.(opts.chatJid)) || HOME_TZ
  const full = deps as BrainDeps
  return {
    system: buildSystem(full, id, new Date(), { name: opts.speaker, inGroup: opts.inGroup, groupChatJid: opts.inGroup ? opts.chatJid : undefined, isOwner: opts.isOwner, softWake: opts.softWake, guest: opts.guest, tz, fromSandbox: opts.fromSandbox }),
    messages: buildConversation(opts.history ?? [], userText, Boolean(opts.inGroup), opts.speaker, opts.resolveName, opts.currentTs, opts.burstGapSec, tz),
    tools: buildTools(full, id, { isOwner: opts.isOwner, inGroup: opts.inGroup, chatJid: opts.chatJid, chatScope: opts.chatScope, guest: opts.guest, tz, fromSandbox: opts.fromSandbox, turnId: opts.turnId }),
  }
}

// The reply shape from a finished turn's text, tool calls and token count.
export function turnReply(text: string, steps: { toolCalls?: ({ toolName: string } | undefined)[] }[], tokens: number): BrainReply {
  const called = (name: string) => steps.some((s) => (s.toolCalls ?? []).some((t) => t?.toolName === name))
  // A reaction IS the whole reply — the responder drops any trailing text the model tacked on.
  return { text: toWhatsAppMarkup(text), asVoice: called('reply_as_voice'), reacted: called('react'), tokens, mediaNote: mediaNoteFromSteps(steps) }
}

export function makeBrain(deps: BrainDeps) {
  const maxSteps = deps.maxSteps ?? 6
  return {
    async respond(id: string, userText: string, opts: RespondOpts = {}): Promise<BrainReply> {
      const { system, messages, tools } = prepareTurn(deps, id, userText, opts)
      const result = await generateText({
        model: deps.model,
        system,
        messages, // recent conversation → continuity ("try again" knows what)
        tools,
        stopWhen: stepCountIs(maxSteps), // tool-iteration cap (runaway-loop guard)
      })
      return turnReply(result.text, result.steps, result.usage?.totalTokens ?? 0)
    },
  }
}
