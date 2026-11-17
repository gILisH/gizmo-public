import { timingSafeEqual } from 'node:crypto'

// The coder's HTTP API is guarded by a shared secret (GIZMO_CODER_SECRET, set for gizmo + coder).
// Lives under src/coder because the coder image copies only this folder.
export const CODER_KEY_HEADER = 'x-gizmo-coder-key'

// Fails closed: no secret configured, or none presented, never matches.
export function keyMatches(given: string | string[] | undefined, secret: string | undefined): boolean {
  if (typeof given !== 'string' || !given || !secret) return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

// A fetch that adds the key to requests for the coder only — never leaks it to other services.
export function withCoderKey(coderUrl: string, key: string | undefined, f: typeof fetch = fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (!key || !String(input instanceof Request ? input.url : input).startsWith(coderUrl)) return f(input, init)
    const headers = new Headers(init?.headers)
    headers.set(CODER_KEY_HEADER, key)
    return f(input, { ...init, headers })
  }) as typeof fetch
}
