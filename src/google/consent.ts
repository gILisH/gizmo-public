import { createServer } from 'node:http'
import { GOOGLE_SCOPES, makeOAuthClient, saveRefreshToken, type GoogleConfig } from './auth'

const PORT = 53682
const REDIRECT = `http://localhost:${PORT}/oauth2callback`

// One-time local consent: print the Google auth URL, catch the redirect on a
// loopback server, exchange the code for a refresh token, persist it. Run on the
// Mac (browser handy); the resulting token later migrates to the droplet.
export async function runConsent(cfg: GoogleConfig): Promise<void> {
  const client = makeOAuthClient({ ...cfg, redirectUri: REDIRECT })
  const url = client.generateAuthUrl({
    access_type: 'offline', // needed to receive a refresh_token
    prompt: 'consent', // force refresh_token even on re-auth
    scope: GOOGLE_SCOPES,
  })

  const code: string = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '', REDIRECT)
      const c = u.searchParams.get('code')
      const err = u.searchParams.get('error')
      res.end(c ? 'Gizmo: Google connected. You can close this tab.' : `Auth failed: ${err ?? 'no code'}`)
      server.close()
      if (c) resolve(c)
      else reject(new Error(err ?? 'no code'))
    })
    server.listen(PORT, () => {
      console.log('\n=== Open this URL in your browser, approve, and return here ===\n')
      console.log(url + '\n')
    })
  })

  const { tokens } = await client.getToken(code)
  if (!tokens.refresh_token) {
    throw new Error('no refresh_token returned — revoke prior access at myaccount.google.com/permissions and retry')
  }
  saveRefreshToken(cfg.tokenPath, tokens.refresh_token)
  console.log(`\nGoogle connected — refresh token saved to ${cfg.tokenPath}\n`)
}
