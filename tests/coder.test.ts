import { describe, it, expect } from 'vitest'
import { makeCoderClient } from '../src/coder/client'
import { prTitle } from '../src/coder/title'
import { selfTools } from '../src/brain/tools/self'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

function client(jobStates: unknown[], postStatus = 202) {
  const sent: string[] = []
  let polls = 0
  const fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json(postStatus, postStatus === 202 ? { id: 'j1' } : { error: 'busy', request: 'pocket-money ledger' })
    return json(200, jobStates[Math.min(polls++, jobStates.length - 1)])
  }) as typeof globalThis.fetch
  const start = makeCoderClient({ url: 'http://coder', send: async (_c, t) => { sent.push(t) }, fetch, sleep: async () => {}, pollMs: 1, maxMs: 10 })
  return { start, sent }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('coder client', () => {
  it('starts, polls past running, posts the PR link to the chat', async () => {
    const { start, sent } = client([{ state: 'running' }, { state: 'done', url: 'https://github.com/x/pull/1', title: 'Better faces' }])
    expect(await start('me@s.whatsapp.net', 'improve faces')).toMatch(/^started/)
    await flush()
    expect(sent).toEqual(['🛠️ PR מוכן: Better faces\nhttps://github.com/x/pull/1'])
  })
  it('reports a failed job', async () => {
    const { start, sent } = client([{ state: 'failed', reason: 'tests failed' }])
    await start('c', 'x')
    await flush()
    expect(sent[0]).toContain('tests failed')
  })
  it('busy sandbox: says so, polls nothing', async () => {
    const { start, sent } = client([], 409)
    expect(await start('c', 'x')).toMatch(/^busy: .*"pocket-money ledger"/)
    await flush()
    expect(sent).toEqual([])
  })
  it('gives up after maxMs with a message', async () => {
    const { start, sent } = client([{ state: 'running' }])
    await start('c', 'x')
    await new Promise((r) => setTimeout(r, 20))
    expect(sent[0]).toContain('יותר מדי זמן')
  })
})

describe('prTitle', () => {
  it('first non-empty line, markdown stripped, capped', () => {
    expect(prTitle('\n## **Sharper face edits**\nbody')).toBe('Sharper face edits')
    expect(prTitle('x'.repeat(100))).toHaveLength(72)
    expect(prTitle('')).toBe('Change requested by the owner')
  })
})

describe('propose_change gating', () => {
  const deps = { proposeChange: { owner: '972500000000', start: async () => 'ok' } } as any
  it('the code owner in his DM gets it', () => {
    expect(Object.keys(selfTools(deps, '972500000000', { chatJid: 'dm' }))).toEqual(['propose_change'])
  })
  it('another owner, any group, a guest group, or no sandbox: absent', () => {
    expect(selfTools(deps, '972511111111', {})).toEqual({})
    expect(selfTools(deps, '972500000000', { inGroup: true })).toEqual({})
    expect(selfTools(deps, '972500000000', { guest: true })).toEqual({})
    expect(selfTools({} as any, '972500000000', {})).toEqual({})
  })
})

describe('appJwt', () => {
  it('is an RS256 JWT for the app that verifies with the key', async () => {
    const { generateKeyPairSync, createVerify } = await import('node:crypto')
    const { appJwt } = await import('../src/coder/github')
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwt = appJwt('42', privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), 1000)
    const [h, p, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iat: 940, exp: 1540, iss: '42' })
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, s, 'base64url')).toBe(true)
  })
})

describe('coder token hygiene', () => {
  it('git auth goes through env, never argv', async () => {
    const { gitAuthEnv } = await import('../src/coder/github')
    const env = gitAuthEnv('ghs_secret123')
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader')
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.split(' ').pop()!, 'base64').toString()).toBe('x-access-token:ghs_secret123')
  })
  it('a real failing git call does not leak the token into the error', async () => {
    const { execFileSync } = await import('node:child_process')
    const { gitAuthEnv, redact } = await import('../src/coder/github')
    const tok = 'ghs_' + 'A'.repeat(36)
    let msg = ''
    try {
      execFileSync('git', ['ls-remote', 'file:///nonexistent/repo.git'], { stdio: 'pipe', env: { ...process.env, ...gitAuthEnv(tok) } })
    } catch (e) { msg = (e as Error).message }
    expect(msg).toMatch(/Command failed/)
    expect(msg).not.toContain(tok)
    expect(msg).not.toContain(Buffer.from(`x-access-token:${tok}`).toString('base64'))
    expect(redact(msg)).toBe(msg)
  })
  it('redact strips auth headers and GitHub tokens', async () => {
    const { redact } = await import('../src/coder/github')
    const b64 = Buffer.from('x-access-token:ghs_abc').toString('base64')
    const out = redact(`Command failed: git -c http.extraHeader=Authorization: Basic ${b64} clone; Bearer: Authorization: bearer ghs_${'x'.repeat(36)} https://x-access-token:ghs_y@github.com`)
    expect(out).not.toContain(b64)
    expect(out).not.toMatch(/ghs_/)
    expect(out).toContain('Authorization: Basic [redacted]')
  })
  it('mints least-privilege tokens: read to clone, write + PRs to publish', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { installationToken, CLONE, PUBLISH } = await import('../src/coder/github')
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    const bodies: unknown[] = []
    const f = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { bodies.push(JSON.parse(String(init.body))); return json(201, { token: 't' }) }
      return json(200, { id: 7 })
    }) as typeof fetch
    await installationToken('1', key, 'o/gizmo', CLONE, f)
    await installationToken('1', key, 'o/gizmo', PUBLISH, f)
    expect(bodies).toEqual([
      { repositories: ['gizmo'], permissions: { contents: 'read' } },
      { repositories: ['gizmo'], permissions: { contents: 'write', pull_requests: 'write' } },
    ])
  })
})

describe('coder API key', () => {
  it('fails closed', async () => {
    const { keyMatches } = await import('../src/coder/auth')
    expect(keyMatches('s3cret', 's3cret')).toBe(true)
    expect(keyMatches('wrong!', 's3cret')).toBe(false)
    expect(keyMatches(undefined, 's3cret')).toBe(false)
    expect(keyMatches('', '')).toBe(false) // no secret configured = nothing gets in
    expect(keyMatches(['s3cret'], 's3cret')).toBe(false)
  })
  it('the client sends it to the coder only', async () => {
    const { withCoderKey, CODER_KEY_HEADER } = await import('../src/coder/auth')
    const seen: Record<string, string | null> = {}
    const f = withCoderKey('http://coder:8787', 'k', (async (url: string, init?: RequestInit) => {
      seen[url] = new Headers(init?.headers).get(CODER_KEY_HEADER)
      return json(200, {})
    }) as typeof fetch)
    await f('http://coder:8787/jobs', { method: 'POST', headers: { 'content-type': 'application/json' } })
    await f('http://worker:8788/cancel')
    expect(seen).toEqual({ 'http://coder:8787/jobs': 'k', 'http://worker:8788/cancel': null })
  })
})
