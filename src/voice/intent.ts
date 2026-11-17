// Does the message explicitly ask for a spoken reply? The model has a reply_as_voice
// tool but honors it inconsistently for TYPED requests, so we force voice on a direct
// ask. Deliberately narrow phrases (not a bare "voice") to avoid "I lost my voice".
const VOICE_REQUESTS = [
  'הקלטה', // recording
  'קולית', // הודעה קולית = voice message
  'וויס',
  'ווייס',
  'voice note',
  'voice message',
  'in voice',
  'as voice',
  'voice reply',
  'reply in voice',
]

export function wantsVoiceReply(text: string): boolean {
  const t = text.toLowerCase()
  return VOICE_REQUESTS.some((p) => t.includes(p))
}
