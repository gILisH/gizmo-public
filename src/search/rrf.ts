// Reciprocal-rank fusion: merge several ranked id-lists into one.
// score(id) = Σ over lists of weight_i / (k + rank). Higher score ranks first.
// `weights` (per-list) lets callers trust one engine more — e.g. semantic over
// exact-token FTS, which misses Hebrew morphology (מוכר vs מוכרת).
export function rrfScored(lists: string[][], k = 60, weights?: number[]): { id: string; score: number }[] {
  const score = new Map<string, number>()
  lists.forEach((list, i) => {
    const w = weights?.[i] ?? 1
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + w / (k + rank))
    })
  })
  return [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score)
}

export function rrfMerge(lists: string[][], k = 60, weights?: number[]): string[] {
  return rrfScored(lists, k, weights).map((r) => r.id)
}
