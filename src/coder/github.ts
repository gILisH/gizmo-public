import { createSign } from 'node:crypto'

// GitHub App auth: a 10-minute JWT signed with the app's private key, exchanged for an
// installation token (valid 1 hour) narrowed to the one repo — fresh per job.
export function appJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`
}

// Least privilege per step: clone gets contents:read; push + PR get contents:write + pull_requests:write.
// GitHub can't scope a token to a branch — contents:write can push main. Only branch protection
// (unavailable on a private free-plan repo) or a fork stops that.
export const CLONE = { contents: 'read' } as const
export const PUBLISH = { contents: 'write', pull_requests: 'write' } as const

export async function installationToken(appId: string, privateKey: string, repo: string, permissions: Record<string, 'read' | 'write'>, f: typeof fetch = fetch): Promise<string> {
  const headers = { Authorization: `Bearer ${appJwt(appId, privateKey)}`, Accept: 'application/vnd.github+json' }
  const inst = (await (await f(`https://api.github.com/repos/${repo}/installation`, { headers })).json()) as { id?: number; message?: string }
  if (!inst.id) throw new Error(`app not installed on ${repo}: ${inst.message}`)
  const res = await f(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ repositories: [repo.split('/')[1]], permissions }),
  })
  const t = (await res.json()) as { token?: string; message?: string }
  if (!t.token) throw new Error(`installation token failed: ${t.message}`)
  return t.token
}

// Git auth through the environment, never argv: a failed execFileSync puts its argv in the
// error message, and that message used to travel to WhatsApp, the DB and the logs.
export const gitAuthEnv = (token: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
})

// Belt and braces for any text leaving the coder: strip auth headers and GitHub tokens.
export const redact = (s: string): string =>
  s
    .replace(/(authorization:\s*(?:basic|bearer|token)\s+)\S+/gi, '$1[redacted]')
    .replace(/x-access-token:[^@\s]+/gi, 'x-access-token:[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]')
