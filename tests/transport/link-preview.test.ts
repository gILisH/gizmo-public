import { describe, it, expect } from 'vitest'
import { generateWAMessageContent } from 'baileys'
import { noLinkPreviews } from '../../src/transport/socket'

describe('noLinkPreviews', () => {
  it('forces getUrlInfo off on every send, keeping the other options', async () => {
    const seen: any[] = []
    const sock = noLinkPreviews({ sendMessage: async (_j: string, _c: any, o: any) => { seen.push(o); return undefined } } as any)
    await sock.sendMessage('c@g.us', { text: 'http://search-ui:8899/api/search' })
    await sock.sendMessage('c@g.us', { text: 'x' }, { quoted: { k: 1 } as any, getUrlInfo: async () => ({}) as any } as any)
    expect(seen[0]).toHaveProperty('getUrlInfo', undefined)
    expect(seen[1].getUrlInfo).toBeUndefined()
    expect(seen[1].quoted).toEqual({ k: 1 })
  })

  it('Baileys builds no preview when getUrlInfo is undefined (the knob works)', async () => {
    const m: any = await generateWAMessageContent({ text: 'see http://169.254.169.254/' }, { getUrlInfo: undefined } as any)
    expect(m.extendedTextMessage?.matchedText ?? m.extendedTextMessage?.title).toBeUndefined()
  })
})
