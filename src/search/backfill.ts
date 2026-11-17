import type { Store } from '../store/types'
import { EmbedderUnavailable, type Embedder } from './embedder'

// Embed + index every message not yet in the vector index. Idempotent — safe to
// run on every startup; only touches messages missing from vec_messages.
export async function backfill(
  store: Store,
  embedder: Embedder,
  log: (m: string) => void = () => {},
): Promise<number> {
  let total = 0
  let failed = 0
  for (;;) {
    const batch = store.getUnindexedMessages(100)
    if (batch.length === 0) break
    let progressed = false
    for (const { id, text } of batch) {
      try {
        store.indexMessage(id, text, await embedder.embed(text))
        total++
        progressed = true
      } catch (err) {
        // Embedder down → stop; the next run retries. Zero-filling here would drop every
        // message from the outage out of semantic search for good.
        if (err instanceof EmbedderUnavailable) {
          log(`backfill: paused (${err.message})`)
          return total
        }
        // Never let one bad message stall the whole index. Mark it indexed with a
        // zero vector so it's not retried forever (still keyword-searchable via FTS).
        failed++
        try {
          store.indexMessage(id, text, new Array(embedder.dim).fill(0))
          progressed = true
        } catch {
          /* give up on this one */
        }
        log(`backfill: skipped a message (${(err as Error).message})`)
      }
    }
    log(`backfill: indexed ${total} (skipped ${failed})...`)
    if (!progressed) break // avoid an infinite loop if nothing can be indexed
  }
  return total
}
