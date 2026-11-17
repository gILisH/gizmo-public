import { timingSafeEqual } from 'node:crypto'

// Shared-secret check for Gizmo's internal HTTP surfaces. Fails closed: no secret configured
// (or none presented) never matches.
export function secretMatches(given: string | undefined, secret: string | undefined): boolean {
  if (!given || !secret) return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
