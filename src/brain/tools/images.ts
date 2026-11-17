import { tool } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { EDITORS } from '../../media/edit'

// Create / edit images, and set Gizmo's own avatar (owner-only). The execute logic lives
// in media/tools (makePeopleImageTools) + fun/; these are the model-facing tool schemas.
export function imageTools(deps: BrainDeps, id: string, ctx: ToolCtx) {
  return {
    ...(deps.sendSavedPhoto
      ? {
          resend_photo: tool({
            description:
              'Re-send a real photo you have ALREADY SEEN — in this chat OR any other group/chat you have access to — by describing which one ("the beach photo savta sent", "the pizza pic from the family group"). You find it in your history and send the ACTUAL saved image here. Use this (NOT generate_image) whenever someone wants an EXISTING photo re-sent/forwarded — never claim you can\'t transfer a photo between chats. If you can\'t find a match, say so.',
            inputSchema: z.object({ query: z.string().describe('describe the photo to find + re-send (who is in it / what it shows / which chat)') }),
            execute: async ({ query }) => deps.sendSavedPhoto!(ctx.chatJid ?? id, query, ctx.chatScope).catch((e: Error) => e.message),
          }),
        }
      : {}),
    ...(deps.generateImage
      ? {
          generate_image: tool({
            description:
              'Create and send a NEW image — a drawing, artwork, or picture — from a text description. Use when someone asks you to make/draw/generate/imagine a picture or image. NOT for re-sending an existing photo (use resend_photo), memes (send_meme), or reaction clips (send_gif).',
            inputSchema: z.object({ prompt: z.string().describe('vivid description of the image to create (English works best for the generator)') }),
            execute: async ({ prompt }) => {
              await deps.generateImage!(ctx.chatJid ?? id, prompt)
              return 'image generated and sent'
            },
          }),
        }
      : {}),
    ...(deps.editImage
      ? {
          edit_image: tool({
            description:
              'EDIT or COMBINE the photo(s) someone just sent in this chat using a natural-language instruction — add/remove/change things, restyle ("make me an eggplant", "turn this into a sketch"), OR compose two photos ("put this guy into the other picture next to the other guy"). You can also ADD a FAMOUS person, character, or object by describing it ("add Madonna next to me", "add a dragon behind us") — you generate them from the description, NO saved photo is needed (this is how you add anyone who is NOT in your saved People roster). Uses the most recent photo(s); if none, ask them to send one. Set photos:2 to combine the two most recent photos — do this when the instruction refers to two pictures/people ("this pic"/"that pic", "him into the other photo"). Optional model: "gemini" (default), "flux" (FLUX.2 klein), or "grok" — only pick one if the person explicitly asks; combining uses gemini or flux (grok can\'t fuse).',
            inputSchema: z.object({
              instruction: z.string().describe('what to change / how to combine (English works best)'),
              model: z.enum(EDITORS).optional().describe('editor to use — only when explicitly requested'),
              photos: z.number().int().min(1).max(2).optional().describe('1 (default) = edit the single most recent photo. 2 = COMBINE mode: fuse the recent photos into one (use when the instruction refers to two pictures/people — the editor gets all recent photos and picks which is which from your instruction).'),
            }),
            execute: async ({ instruction, model, photos }) => deps.editImage!(ctx.chatJid ?? id, instruction, model, photos),
          }),
        }
      : {}),
    ...(deps.editKeepFace
      ? {
          edit_keep_face: tool({
            description:
              'Edit the photo just sent while keeping the person\'s FACE 100% pixel-identical — change their clothes, background, or setting, but the face is preserved exactly (not re-generated). Use ONLY when the owner explicitly wants their real face kept unchanged ("keep my face exactly", "same face, put me in a tuxedo", "אותם פנים בדיוק"). For normal edits or adding people use edit_image. Needs a photo with a clear face; if none, ask for one.',
            inputSchema: z.object({
              instruction: z.string().describe('what to change around the face — clothes, background, scene (English works best)'),
            }),
            execute: async ({ instruction }) => deps.editKeepFace!(ctx.chatJid ?? id, instruction),
          }),
        }
      : {}),
    ...(ctx.isOwner && deps.setAvatar
      ? {
          set_avatar: tool({
            description:
              'Change YOUR OWN WhatsApp profile picture (avatar). Use the photo the owner just sent (leave description empty), OR generate a new avatar from a description. Owner-only.',
            inputSchema: z.object({
              description: z.string().optional().describe('what the new avatar should look like; OMIT to use the image the owner just sent'),
            }),
            execute: async ({ description }) => deps.setAvatar!({ chatJid: ctx.chatJid ?? id, description }),
          }),
        }
      : {}),
  }
}
