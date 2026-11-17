import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { outboundContentSchema, composeOutbound } from './outbound'

// Owner-only reach beyond this chat: post to a group from a DM. The cross-chat send surface is single-sourced from ./outbound (composeOutbound), so
// it never drifts from the in-chat capabilities, and EVERY cross-chat send is staged +
// confirmed (the privacy boundary): owner-only, only groups Gizmo is in, read-back the
// resolved group name, and nothing leaves until the owner approves.
export function groupTools(deps: BrainDeps, _id: string, ctx: ToolCtx): ToolSet {
  if (!ctx.isOwner) return {}
  return {
    post_to_group: tool({
      description:
        'Send to a group FROM a DM — anything you can send in a chat, via `content`: text, imagePrompt (+ people for their REAL saved faces), voice, meme, gif, poll, location, contact (mix as needed). ' +
        'Omit `group` for the HOUSEHOLD group — the owners\' PRIVATE group (you + Alex + Gizmo), NOT the big family group; omit it whenever the owner means "our group"/"the group with Alex". Name a group only to target a different named group you are in. ' +
        'For a photo of SAVED people ("me and Alex"), you MUST list their roster names in content.people or the faces are invented. ' +
        'This does NOT send — it STAGES and you must confirm the exact group with the owner first (see the return value).',
      inputSchema: z.object({
        group: z.string().optional().describe('group name; omit for the household (private owners\') group'),
        content: outboundContentSchema,
      }),
      execute: async ({ group, content }) => {
        let g: string | undefined
        try {
          g = deps.findGroup(group) // whitelist: only trusted groups Gizmo is IN
        } catch (e) {
          return (e as Error).message // ambiguous name — list the options, never guess
        }
        if (!g) return group ? `couldn't find a group named "${group}" that I'm in` : 'no household group found yet'
        const from = ctx.chatJid ?? _id

        // Resolve the photo ONCE, now — the captured bytes are what we PREVIEW and later SEND
        // (re-resolving at confirm time made the preview differ from what got sent).
        let photo: Buffer | null = null
        if (content.photo && deps.resolvePhoto) {
          photo = await deps.resolvePhoto(content.photo, from, ctx.chatScope)
          if (!photo) return "couldn't find that photo — reply to the exact photo you mean, or resend it here and I'll forward it"
        }
        const rest = composeOutbound(deps, g, content) // text/imagePrompt/poll/gif/… (photo handled here)
        if (!photo && !rest) return 'nothing to send — put something in content (text/imagePrompt/photo/poll/…)'

        // Preview the resolved photo back to the OWNER's chat so they verify BEFORE confirming.
        // The preview goes to `from` (outside the confirm gate — safe); only the group send is gated.
        if (photo && deps.sendPhotoBytes) await deps.sendPhotoBytes(from, photo)

        const name = deps.chatName(g) ?? group ?? 'your group'
        // The staged thunk sends the CAPTURED buffer — it never re-resolves.
        const run = async () => {
          if (photo && deps.sendPhotoBytes) await deps.sendPhotoBytes(g, photo)
          if (rest) await rest()
        }
        deps.stagePost(from, name, run, ctx.turnId ?? '') // staged; the ONLY cross-chat delivery path
        return photo
          ? `Sent a PREVIEW of the photo above — that's exactly what will go. STAGED for "${name}", not sent yet. Ask the owner to confirm it's the right photo + group ("זה? לשלוח ל־${name}?"). Only after they say yes call confirm_send; if no, cancel_send.`
          : `STAGED for "${name}" — not sent yet. Tell the owner exactly which group and ask them to approve ("אני עומד לשלוח ל־${name} — לאשר?"). Only after they say yes call confirm_send; if no, cancel_send.`
      },
    }),
    confirm_send: tool({
      description:
        'Actually send the group message you STAGED with post_to_group, after the owner approved it in their reply ("yes"/"כן"/"שלח"/"go"). Call this ONLY once they\'ve confirmed — never in the same turn you staged it.',
      inputSchema: z.object({}),
      execute: async () => deps.confirmPost(ctx.chatJid ?? _id, ctx.turnId ?? ''), // no turn id → same '' → refused (fail closed)
    }),
    cancel_send: tool({
      description: 'Discard a staged group send when the owner declines it ("no"/"לא"/"בטל") or changes their mind.',
      inputSchema: z.object({}),
      execute: async () => deps.cancelPost(ctx.chatJid ?? _id),
    }),
  }
}
