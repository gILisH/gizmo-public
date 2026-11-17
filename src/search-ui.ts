// Tiny self-contained web UI to search the corpus by hand. Runs as its own service,
// reachable over the tailnet (public inbound is firewalled). Owner-view by default.
// Gated by GIZMO_SEARCH_UI_KEY: open /?key=<it> once, a cookie carries it after that.
// No framework — stdlib http + inline HTML.
import { createServer } from 'node:http'
import { loadConfig } from './config'
import { openStore } from './store'
import { makeSearch } from './search'
import { OllamaEmbedder } from './search/embedder'
import { parseDayRange } from './brain'
import { isGroupJid } from './access/jid'
import { secretMatches } from './secret'
import { COOKIE, presentedKey, renderPage } from './search-ui-page'

// The whole family archive sits behind this page: no key, no server (fail closed).
const KEY = process.env.GIZMO_SEARCH_UI_KEY ?? ''
if (!KEY) throw new Error('GIZMO_SEARCH_UI_KEY is required')
const cfg = loadConfig()
const store = openStore(cfg.dbPath)
const { search } = makeSearch(store, new OllamaEmbedder())
const feedOwner = cfg.googleOwner ?? cfg.owners[0]
const botExclude = ['gizmo', `${cfg.dedicatedNumber}@s.whatsapp.net`]
const port = Number(process.env.GIZMO_UI_PORT ?? 8899)

const ownerName = (p: string) => cfg.ownerNames[p] ?? p
const PAGE = renderPage({
  ownerLabel: ownerName(feedOwner),
  groups: store.dedicatedGroups().map((jid) => ({ jid, name: store.getChatName(jid) ?? undefined })),
})

const json = (res: any, obj: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (!secretMatches(presentedKey(url, req.headers.cookie), KEY)) {
    res.writeHead(401, { 'content-type': 'text/plain' })
    return res.end('open /?key=<GIZMO_SEARCH_UI_KEY> once')
  }
  // Key arrived in the URL: move it into a cookie and drop it from the address bar/history.
  if (url.searchParams.has('key')) {
    res.writeHead(303, {
      'set-cookie': `${COOKIE}=${encodeURIComponent(KEY)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      location: '/',
    })
    return res.end()
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(PAGE)
  }
  if (url.pathname === '/api/search') {
    const q = url.searchParams.get('q') ?? ''
    const after = url.searchParams.get('after') || undefined
    const before = url.searchParams.get('before') || undefined
    // Empty scope = search everything (owner). A group jid = only that group's messages.
    const chatScope = url.searchParams.get('scope') || undefined
    try {
      const hits = await search(q, {
        limit: Number(url.searchParams.get('limit') ?? 15),
        from: url.searchParams.get('from') || undefined,
        after: after ? parseDayRange(after)[0] : undefined,
        before: before ? parseDayRange(before)[1] : undefined,
        chatScope,
        sort: (url.searchParams.get('sort') as 'relevance' | 'recent') || undefined,
        excludeSenders: url.searchParams.get('hidebot') ? botExclude : undefined, // show Gizmo by default
      })
      return json(res, {
        scoped: chatScope,
        results: hits.map((m) => ({
          date: new Date(m.ts * 1000).toISOString().slice(0, 16).replace('T', ' '),
          chatName: m.chatName,
          isGroup: isGroupJid(m.chatJid),
          senderName: m.senderName,
          text: m.text,
        })),
      })
    } catch (err) {
      return json(res, { results: [], error: (err as Error).message })
    }
  }
  res.writeHead(404)
  res.end('not found')
}).listen(port, () => console.log(`search UI on :${port}`))
