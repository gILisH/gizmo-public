import { describe, it, expect } from 'vitest'
import { renderPage, presentedKey, escapeHtml } from '../src/search-ui-page'
import { secretMatches } from '../src/secret'
import { withWorkerKey, WORKER_KEY_HEADER } from '../src/worker/auth'

describe('search-ui page', () => {
  it('escapes group names and jids (anyone can name a group and add Gizmo)', () => {
    const page = renderPage({
      ownerLabel: 'Dan<b>',
      groups: [{ jid: '1@g.us"><script>alert(1)</script>', name: '<script>alert(document.cookie)</script>' }],
    })
    expect(page).not.toContain('<script>alert')
    expect(page).not.toContain('Dan<b>')
    expect(page).toContain('in: &lt;script&gt;alert(document.cookie)&lt;/script&gt;')
    expect(page).toContain('value="1@g.us&quot;&gt;&lt;script&gt;')
  })

  it('escapeHtml covers attribute quotes too', () => {
    expect(escapeHtml(`a&<>"'`)).toBe('a&amp;&lt;&gt;&quot;&#39;')
  })

  it('takes the key from ?key= or the cookie', () => {
    expect(presentedKey(new URL('http://x/?key=abc'), undefined)).toBe('abc')
    expect(presentedKey(new URL('http://x/api/search'), 'foo=1; gizmo_ui=s%3Dcret')).toBe('s=cret')
    expect(presentedKey(new URL('http://x/'), 'other=1')).toBeUndefined()
  })
})

describe('secretMatches', () => {
  it('fails closed', () => {
    expect(secretMatches('k', 'k')).toBe(true)
    expect(secretMatches('k', 'K')).toBe(false)
    expect(secretMatches('k', 'kk')).toBe(false)
    expect(secretMatches(undefined, 'k')).toBe(false)
    expect(secretMatches('', '')).toBe(false) // no secret configured never matches
    expect(secretMatches('x', undefined)).toBe(false)
  })
})

describe('withWorkerKey', () => {
  it('adds the key to worker calls only', async () => {
    const seen: Record<string, string | null> = {}
    const base = (async (url: string, init?: RequestInit) => {
      seen[url] = new Headers(init?.headers).get(WORKER_KEY_HEADER)
      return new Response('{}')
    }) as typeof fetch
    const f = withWorkerKey('http://worker:8788', 'sekret', base)
    await f('http://worker:8788/events?after=0')
    await f('http://worker:8788/messages', { method: 'POST', headers: { 'content-type': 'application/json' } })
    await f('http://coder:8787/cancel', { method: 'POST' })
    expect(seen['http://worker:8788/events?after=0']).toBe('sekret')
    expect(seen['http://worker:8788/messages']).toBe('sekret')
    expect(seen['http://coder:8787/cancel']).toBeNull()
  })
})
