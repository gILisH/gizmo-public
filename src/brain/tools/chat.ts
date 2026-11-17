import { tool } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'

// In-chat expression: captioned memes, reaction GIFs, and opting into a spoken voice-note
// reply. All target the current chat.
export function chatTools(deps: BrainDeps, id: string, ctx: ToolCtx) {
  return {
    send_meme: tool({
      description:
        'Send a captioned meme to this chat — great for ribbing. Pick the template whose FORMAT fits the joke:\n' +
        '- drake — reject the top thing, prefer the bottom thing\n' +
        '- ds — Daily Struggle (two buttons): agonizing between two options, or hypocrisy\n' +
        '- pooh — plain phrasing (top) vs fancy phrasing of the same thing (bottom)\n' +
        '- spiderman — two things that are identical, or two people blaming each other\n' +
        '- mordor — "one does not simply [do X]"\n' +
        '- fry — "not sure if X or Y"\n' +
        '- rollsafe — "can\'t have [problem] if you [dubious clever move]"\n' +
        '- cmm — a hot take + "change my mind"\n' +
        '- aag — Ancient Aliens guy: "it\'s obviously [X]"\n' +
        '- spongebob — Mocking SpongeBob: sarcastically echoing what someone said\n' +
        '- oprah — "you get an X! everyone gets an X!"\n' +
        '- buzz — "[X], [X] everywhere"\n' +
        '- gru — a plan whose final step backfires (put a beat in each caption)\n' +
        '- disastergirl — smug in front of chaos you caused\n' +
        '- blb — everything goes wrong (bad luck)\n' +
        '- fine — pretending all is well amid disaster\n' +
        '- success, stonks, doge, both — nailed it / dubious win / wow / why not both\n' +
        'VARY your choice: the chat shows memes you recently sent as [meme: <template>] — pick a DIFFERENT template that fits, do NOT default to drake. Captions: short and punchy, Hebrew or English both render; skip emoji (they don\'t show on memes).',
      inputSchema: z.object({
        template: z.string().describe('one of the template ids above'),
        top: z.string().describe('top caption (may be empty)'),
        bottom: z.string().describe('bottom caption (may be empty)'),
      }),
      execute: async ({ template, top, bottom }) => {
        await deps.sendMeme(ctx.chatJid ?? id, template, top ?? '', bottom ?? '')
        return 'meme sent'
      },
    }),
    send_gif: tool({
      description:
        'Send a reaction GIF to this chat (searches for a fitting clip). Use for reactions — "facepalm", "mic drop", "eye roll", "mind blown", etc.',
      inputSchema: z.object({ query: z.string().describe('what the GIF should show') }),
      execute: async ({ query }) => {
        await deps.sendGif(ctx.chatJid ?? id, query)
        return 'gif sent'
      },
    }),
    reply_as_voice: tool({
      description:
        'Call this to reply with a spoken VOICE NOTE instead of text. Use ONLY when the person can\'t read right now (says they\'re driving, hands full, eyes busy) or explicitly asks for voice. Your text answer is what gets spoken — keep it natural for listening.',
      inputSchema: z.object({}),
      execute: async () => 'ok — replying with a voice note',
    }),
  }
}
