import { z } from 'zod'
import type { BrainDeps } from '../types'

// The SINGLE definition of "what Gizmo can send to a chat" — schema + delivery in one
// place, so the cross-chat path (post_to_group) can never drift from the in-chat tools
// again. Add a capability here once and every consumer gets it.
export const outboundContentSchema = z.object({
  text: z.string().optional().describe('a text message (or the words to speak if voice:true)'),
  imagePrompt: z.string().optional().describe('GENERATE a new photo of this scene'),
  photo: z.string().optional().describe('RE-SEND an existing photo you have already seen (in any chat/group) — describe which one ("the beach photo savta sent", "the pizza pic from the family group") and you attach the ACTUAL saved image. Use this instead of imagePrompt when the owner means an existing photo, not a generated one.'),
  people: z.array(z.string()).optional().describe('saved roster names to render with their REAL faces in imagePrompt (e.g. ["Dan","Alex"]); omit for invented faces'),
  voice: z.boolean().optional().describe('speak `text` as a voice note instead of sending it as text'),
  meme: z.object({ template: z.string(), top: z.string().optional(), bottom: z.string().optional() }).optional(),
  gif: z.string().optional().describe('reaction-GIF search query'),
  poll: z.object({ question: z.string(), options: z.array(z.string()).min(2).max(12) }).optional(),
  location: z.object({ latitude: z.number(), longitude: z.number(), name: z.string().optional() }).optional(),
  contact: z.object({ name: z.string(), phone: z.string() }).optional(),
})
export type OutboundContent = z.infer<typeof outboundContentSchema>

// Build a delivery thunk that sends `content` to `targetJid` using the existing deps.
// Returns null if there's nothing to send. The caller decides WHEN to run it — in-chat
// = immediately; cross-chat = only after the owner confirms (privacy gate).
export function composeOutbound(deps: BrainDeps, targetJid: string, c: OutboundContent): (() => Promise<void>) | null {
  const steps: Array<() => Promise<unknown>> = [] // composeScene returns a status string; others void
  if (c.imagePrompt) {
    const faces = (c.people?.length ?? 0) > 0 // real saved faces vs a generic image
    if (faces && deps.composeScene) steps.push(() => deps.composeScene!(targetJid, c.people!, c.imagePrompt!))
    else if (deps.generateImage) steps.push(() => deps.generateImage!(targetJid, c.imagePrompt!))
  }
  // NOTE: c.photo is handled specially by post_to_group (resolve-once + preview + capture the
  // bytes), NOT here — composing a query-based re-resolve at confirm time made preview ≠ sent.
  if (c.voice && c.text && deps.sendVoiceNote) steps.push(() => deps.sendVoiceNote!(targetJid, c.text!))
  else if (c.text) steps.push(() => deps.sendText(targetJid, c.text!))
  if (c.meme) steps.push(() => deps.sendMeme(targetJid, c.meme!.template, c.meme!.top ?? '', c.meme!.bottom ?? ''))
  if (c.gif) steps.push(() => deps.sendGif(targetJid, c.gif!))
  if (c.poll && deps.sendPoll) steps.push(() => deps.sendPoll!(targetJid, c.poll!.question, c.poll!.options))
  if (c.location && deps.sendLocation) steps.push(() => deps.sendLocation!(targetJid, c.location!.latitude, c.location!.longitude, c.location!.name))
  if (c.contact && deps.sendContact) steps.push(() => deps.sendContact!(targetJid, c.contact!.name, c.contact!.phone))
  if (steps.length === 0) return null
  return async () => { for (const s of steps) await s() }
}
