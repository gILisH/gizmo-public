import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

// Scopes requested at consent. Read-only where possible (blast-radius); add
// write scopes only when a write tool is actually built.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly', // read-only (no send)
  'https://www.googleapis.com/auth/calendar', // full (read + create events)
  'https://www.googleapis.com/auth/documents', // full (read + create/edit docs)
  'https://www.googleapis.com/auth/spreadsheets', // full (read + write sheets)
  // drive omitted — not granted; Docs/Sheets create works without it.
]

export interface GoogleConfig {
  clientId: string
  clientSecret: string
  tokenPath: string // where the refresh token is persisted (0600)
  redirectUri?: string
}

export function makeOAuthClient(cfg: GoogleConfig): OAuth2Client {
  return new google.auth.OAuth2(
    cfg.clientId,
    cfg.clientSecret,
    cfg.redirectUri ?? 'http://localhost:53682/oauth2callback',
  )
}

export function saveRefreshToken(tokenPath: string, refreshToken: string): void {
  mkdirSync(dirname(tokenPath), { recursive: true })
  writeFileSync(tokenPath, JSON.stringify({ refresh_token: refreshToken }), { mode: 0o600 })
}

export function hasToken(tokenPath: string): boolean {
  return existsSync(tokenPath)
}

// Build an authorized client from the stored refresh token. googleapis
// auto-refreshes the short-lived access token as needed.
export function authorizedClient(cfg: GoogleConfig): OAuth2Client {
  if (!existsSync(cfg.tokenPath)) throw new Error('google not authorized — run `npm run cli -- google-auth`')
  const { refresh_token } = JSON.parse(readFileSync(cfg.tokenPath, 'utf8')) as { refresh_token: string }
  const client = makeOAuthClient(cfg)
  client.setCredentials({ refresh_token })
  return client
}
