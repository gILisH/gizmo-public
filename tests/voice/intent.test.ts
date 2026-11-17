import { describe, it, expect } from 'vitest'
import { wantsVoiceReply } from '../../src/voice/intent'

describe('wantsVoiceReply', () => {
  it('detects explicit Hebrew requests', () => {
    expect(wantsVoiceReply('תענה לי בהודעה קולית')).toBe(true)
    expect(wantsVoiceReply('תשלח לי הקלטה של זה')).toBe(true)
    expect(wantsVoiceReply('תגיב בוויס')).toBe(true)
  })
  it('detects explicit English requests', () => {
    expect(wantsVoiceReply('reply with a voice note')).toBe(true)
    expect(wantsVoiceReply('answer in voice please')).toBe(true)
  })
  it('ignores ordinary messages', () => {
    expect(wantsVoiceReply('מה השעה עכשיו?')).toBe(false)
    expect(wantsVoiceReply('what time is it')).toBe(false)
    expect(wantsVoiceReply('I lost my voice yesterday')).toBe(false) // "voice" alone is not a request
    expect(wantsVoiceReply('')).toBe(false)
  })
})
