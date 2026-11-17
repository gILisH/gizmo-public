import { FakeTransport } from './transport/fake'
import { makeEchoHandler } from './handler'
import type { InboundMessage } from './transport/types'
import { isGroupJid } from './access/jid'
import { dirname, join } from 'node:path'

export async function runSend(fromJid: string, text: string): Promise<string[]> {
  const t = new FakeTransport()
  t.onMessage(makeEchoHandler(t))
  const msg: InboundMessage = {
    id: 'CLI', chatJid: fromJid, senderJid: fromJid,
    text, ts: Date.now(), fromMe: false,
  }
  await t.inject(msg)
  return t.sent.map((m) => m.text)
}

async function main() {
  const argv = process.argv.slice(2)

  // gizmo google-auth — one-time Google OAuth consent (local browser flow)
  if (argv[0] === 'google-auth') {
    const { loadConfig } = await import('./config')
    const { runConsent } = await import('./google/consent')
    const cfg = loadConfig()
    if (!cfg.googleClientId || !cfg.googleClientSecret) {
      console.error('set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first')
      process.exit(1)
    }
    await runConsent({ clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret, tokenPath: cfg.googleTokenPath })
    return
  }

  // gizmo import-contacts <file.vcf> — populate the address book from a phone export
  if (argv[0] === 'import-contacts') {
    const file = argv[1]
    if (!file) {
      console.error('usage: npm run cli -- import-contacts <file.vcf>')
      process.exit(1)
    }
    const { readFileSync } = await import('node:fs')
    const { loadConfig } = await import('./config')
    const { openStore } = await import('./store')
    const { parseVCards } = await import('./ingest/vcard')
    const store = openStore(loadConfig().dbPath)
    const contacts = parseVCards(readFileSync(file, 'utf8'))
    let n = 0
    for (const c of contacts) {
      for (const phone of c.phones) {
        store.upsertContact(`${phone}@s.whatsapp.net`, c.name)
        n++
      }
    }
    console.log(`imported ${contacts.length} contacts (${n} phone→name mappings)`)
    store.close()
    return
  }

  // gizmo purge-statuses — one-off: delete WhatsApp status (story) and channel rows ingested
  // before they were filtered out, plus their search index and saved photos.
  if (argv[0] === 'purge-statuses') {
    const { loadConfig } = await import('./config')
    const { openStore } = await import('./store')
    const { purgeStatuses } = await import('./purge')
    const cfg = loadConfig()
    const store = openStore(cfg.dbPath)
    const n = purgeStatuses(store, join(dirname(cfg.dbPath), 'media'))
    console.log(`deleted ${n.rows} status/channel messages and ${n.files} saved photos`)
    store.close()
    return
  }

  // gizmo search <query...> [--as <id>] [--from <name>] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--limit N]
  // Deterministic search against the live corpus — no LLM. --as tests the ACL scope
  // (what that requester would see); feed owner sees all.
  if (argv[0] === 'search' || argv[0] === 'recent' || argv[0] === 'oldest') {
    const mode = argv[0]
    const flag = (name: string) => {
      const i = argv.indexOf(`--${name}`)
      return i !== -1 ? argv[i + 1] : undefined
    }
    const queryParts: string[] = []
    for (let i = 1; i < argv.length; i++) {
      if (argv[i].startsWith('--')) i++ // skip flag + its value
      else queryParts.push(argv[i])
    }
    const query = queryParts.join(' ').trim()
    const { loadConfig } = await import('./config')
    const { openStore } = await import('./store')
    const { makeSearch } = await import('./search')
    const { OllamaEmbedder } = await import('./search/embedder')
    const { parseDayRange } = await import('./brain')
    const cfg = loadConfig()
    const store = openStore(cfg.dbPath)
    const chatScope = flag('in') || undefined // --in <chatJid>: scope to one chat (omit = everything)
    const limit = Number(flag('limit') ?? 15)
    const fmt = (m: any) => {
      const day = new Date(m.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
      const where = m.chatName ? ` · ${m.chatName}` : isGroupJid(m.chatJid) ? ' · group' : ''
      return `[${day}${where}] ${m.senderName ?? 'Unknown'}: ${(m.text ?? '').replace(/\n/g, ' ').slice(0, 70)}`
    }
    let rows: any[]
    if (mode === 'recent') rows = store.recentMessages(limit, { chatScope })
    else if (mode === 'oldest') rows = store.oldestMessages(limit, { chatScope })
    else {
      const after = flag('after'), before = flag('before')
      rows = await makeSearch(store, new OllamaEmbedder()).search(query, {
        limit, chatScope, from: flag('from'),
        after: after ? parseDayRange(after)[0] : undefined,
        before: before ? parseDayRange(before)[1] : undefined,
        sort: flag('sort') as 'relevance' | 'recent' | undefined,
        excludeSenders: ['gizmo', `${cfg.dedicatedNumber}@s.whatsapp.net`], // match production (drop bot turns)
      })
    }
    console.log(`${mode}${query ? ` "${query}"` : ''}${chatScope ? ` (in ${chatScope})` : ' (everything)'} → ${rows.length} results:`)
    rows.forEach((m, i) => console.log(`${String(i + 1).padStart(2)}. ${fmt(m)}`))
    store.close()
    return
  }

  // expected: dev send --from <jid> <text...>
  if (argv[0] !== 'dev' || argv[1] !== 'send') {
    console.error('usage: npm run cli -- dev send --from <jid> <text...>\n       | google-auth | import-contacts <file.vcf> | purge-statuses\n       | search <query> [--as <id>] [--from <name>] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--limit N]\n       | recent [--as <id>] [--limit N] | oldest [--as <id>] [--limit N]')
    process.exit(1)
  }
  const fromIdx = argv.indexOf('--from')
  if (fromIdx === -1 || !argv[fromIdx + 1]) {
    console.error('missing --from <jid>')
    process.exit(1)
  }
  const fromJid = argv[fromIdx + 1]
  const text = argv.slice(fromIdx + 2).join(' ')
  const replies = await runSend(fromJid, text)
  for (const r of replies) console.log(`gizmo> ${r}`)
}

// run main only when invoked directly, not when imported by tests
if (process.argv[1]?.endsWith('cli.ts')) {
  main()
}
