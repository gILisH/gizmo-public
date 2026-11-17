import { tool } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { toolResult } from '../format'

// Live internet: search (snippets + sources) and full-page fetch. Each is exposed only
// when its dep is wired, and wrapped in toolResult so a network failure comes back as
// text the model works around instead of aborting the whole turn.
export function webTools(deps: BrainDeps, id: string, ctx: ToolCtx) {
  return {
    ...(deps.webSearch
      ? {
          web_search: tool({
            description:
              'Search the live internet for current information not in the person\'s WhatsApp history — news, prices, facts, weather, sports, how something works, links they mention. Returns a short answer plus sources, and image URLs when there are any.',
            inputSchema: z.object({ query: z.string().describe('what to search for (any language)') }),
            execute: async ({ query }) => toolResult(() => deps.webSearch!(query), "couldn't search the web"),
          }),
        }
      : {}),
    ...(deps.webFetch
      ? {
          web_fetch: tool({
            description:
              'Open and read a full web page by URL — use for a link someone sent, or to read a promising source from web_search in full (web_search only gives snippets). Renders the page like a browser, so most JS/soft-blocked sites work. Returns the page text. Some sites (hard bot-walls, logins, paywalls) still can\'t be read — say so if it fails.',
            inputSchema: z.object({ url: z.string().describe('the full URL to read') }),
            execute: async ({ url }) => toolResult(() => deps.webFetch!(url), "couldn't read that page"),
          }),
        }
      : {}),
    ...(deps.sendWebMedia
      ? {
          send_from_url: tool({
            description:
              'Download a photo or file from the web and SEND THE ACTUAL THING in this chat — e.g. photos of a hotel, product, place or person you found, or a PDF/menu/ticket. Use whenever someone wants to SEE something you found online: show the pictures, don\'t just send links. Takes a DIRECT image/file URL (from web_search Images, or an image URL inside a web_fetch page) — not a regular page link. One call per photo; send a few (2–5) for "show me", each with a short caption saying what it is.',
            inputSchema: z.object({
              url: z.string().describe('direct URL of the image or file'),
              caption: z.string().optional().describe('short caption, e.g. the hotel name'),
            }),
            execute: async ({ url, caption }) => toolResult(() => deps.sendWebMedia!(ctx.chatJid ?? id, url, caption), "couldn't download/send that"),
          }),
        }
      : {}),
  }
}
