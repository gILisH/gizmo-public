import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { BRAINS, type BrainDeps, type ToolCtx } from '../types'
import { EDITORS } from '../../media/edit'

// Owner-only runtime settings: which model runs the chat brain, and the default image editor.
export function settingsTools(deps: BrainDeps, _id: string, ctx: ToolCtx): ToolSet {
  if (!ctx.isOwner) return {}
  return {
    ...(deps.switchBrain
      ? {
          switch_model: tool({
            description:
              'Switch which AI model runs you: "claude" (Claude Sonnet — reliable, warmer), "gemini" (Gemini Flash — cheaper, faster), or "grok" (Grok — wittier, edgier). Use when the owner asks you to switch/use a specific model. Owner-only.',
            inputSchema: z.object({ model: z.enum(BRAINS) }),
            execute: async ({ model }) => deps.switchBrain!(model),
          }),
        }
      : {}),
    ...(deps.switchImageModel
      ? {
          switch_image_model: tool({
            description:
              'Switch the default IMAGE model (photo generation/editing), separate from your chat brain: "gemini" (nano-banana — fuses multiple photos / multi-person scenes), "flux" (FLUX.2 klein — also fuses multiple reference photos, fast + high detail), or "grok" (xAI grok-imagine — single-image only). Use when the owner asks to change the image/photo model. Note: multi-person scenes and adding people into a photo need a fusion model (gemini or flux); grok can\'t fuse. Owner-only.',
            inputSchema: z.object({ model: z.enum(EDITORS) }),
            execute: async ({ model }) => deps.switchImageModel!(model),
          }),
        }
      : {}),
  }
}
