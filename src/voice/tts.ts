import { spawn } from 'node:child_process'

// WhatsApp voice notes (ptt) must be Opus in an OGG container — MP3 renders as
// "something is wrong with the audio file". WhatsApp Web additionally needs the
// message's duration set, or it won't play (phone recomputes it, Web doesn't).
// So we transcode (voice-tuned Opus) AND probe the duration.
export interface VoiceNote {
  ogg: Buffer
  seconds: number
}

export async function toVoiceNote(mp3: Buffer): Promise<VoiceNote> {
  // Transcode + read the input Duration from ffmpeg's own stderr (it decodes the
  // whole MP3, so it's accurate — unlike ffprobe over a non-seekable pipe).
  const { out, err } = await run(['-i', 'pipe:0', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip', '-f', 'ogg', 'pipe:1'], mp3)
  // "Duration:" is N/A for a piped input; the final progress "time=" is the real length.
  const times = [...err.matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
  const last = times.at(-1)
  const seconds = last ? Math.max(1, Math.round(+last[1] * 3600 + +last[2] * 60 + +last[3])) : 1
  return { ogg: out, seconds }
}

export function run(args: string[], input: Buffer): Promise<{ out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args)
    const out: Buffer[] = []
    const err: Buffer[] = []
    p.stdout.on('data', (c) => out.push(c))
    p.stderr.on('data', (c) => err.push(c))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0
        ? resolve({ out: Buffer.concat(out), err: Buffer.concat(err).toString() })
        : reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString().slice(-200)}`)),
    )
    p.stdin.write(input)
    p.stdin.end()
  })
}

// ElevenLabs text→speech. Multilingual model (strong Hebrew). Returns MP3 bytes.
export interface TtsConfig {
  apiKey: string
  voiceId: string
  model?: string
}

export function ttsFromEnv(): TtsConfig | null {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return null
  return {
    apiKey,
    // Liam (young male); override with ELEVENLABS_VOICE_ID.
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? 'TX3LPaxmHKxFdv7VOQHJ',
    // eleven_v3 = most natural at non-English (best Hebrew); override with ELEVENLABS_MODEL.
    model: process.env.ELEVENLABS_MODEL ?? 'eleven_v3',
  }
}

export async function synthesize(text: string, cfg: TtsConfig): Promise<Buffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: cfg.model ?? 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })
  if (!res.ok) throw new Error(`elevenlabs tts ${res.status}: ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}
