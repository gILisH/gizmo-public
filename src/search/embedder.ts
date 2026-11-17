export interface Embedder {
  readonly dim: number
  embed(text: string): Promise<number[]>
}

// Deterministic, dependency-free embedder for tests ($0, no Ollama).
// Not semantically meaningful — just stable + distinct per text.
export class FakeEmbedder implements Embedder {
  constructor(readonly dim: number = 4) {}

  async embed(text: string): Promise<number[]> {
    const v = new Array(this.dim).fill(0)
    let h = 5381
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
      v[i % this.dim] += (h % 1000) / 1000
    }
    // normalize to unit length (avoid all-zero)
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
}

// bge-m3 context is bounded; a very long message (forwarded article, etc.) blows
// it and Ollama returns HTTP 500 instead of truncating. Cap input to a safe
// length — the head of a message carries its topic for retrieval.
export const MAX_EMBED_CHARS = 2000
export function truncateForEmbed(text: string, max: number = MAX_EMBED_CHARS): string {
  return text.length > max ? text.slice(0, max) : text
}

// The embedder itself can't be reached (Ollama down / restarting) — nothing to do with the
// message, so the caller should retry later rather than give up on it.
export class EmbedderUnavailable extends Error {}

// Local embeddings via Ollama (bge-m3, multilingual/Hebrew, 1024-dim).
export class OllamaEmbedder implements Embedder {
  readonly dim: number
  private base: string
  private model: string

  constructor(opts: { base?: string; model?: string; dim?: number } = {}) {
    this.base = opts.base ?? process.env.GIZMO_OLLAMA_URL ?? 'http://localhost:11434'
    this.model = opts.model ?? process.env.GIZMO_EMBED_MODEL ?? 'bge-m3'
    this.dim = opts.dim ?? 1024
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.base}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: truncateForEmbed(text) }),
    }).catch((err: Error) => {
      throw new EmbedderUnavailable(`ollama unreachable: ${err.message}`)
    })
    if (!res.ok) throw new Error(`ollama embeddings failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { embedding: number[] }
    return data.embedding
  }
}
