import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import type { Store, StoredMessage } from './types'
import { isGroupJid } from '../access/jid'

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_jid    TEXT NOT NULL,
  sender_jid  TEXT NOT NULL,
  sender_name TEXT,
  text        TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  from_me     INTEGER NOT NULL,
  source      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts);
CREATE TABLE IF NOT EXISTS contacts (
  jid  TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  jid  TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
-- Per-chat access/membership ACL: which people (canonical phone or raw jid) are in a
-- chat. The idOrg-style filter — every history read scopes to the requester's chats.
CREATE TABLE IF NOT EXISTS chat_members (
  chat_jid TEXT NOT NULL,
  member   TEXT NOT NULL,
  PRIMARY KEY (chat_jid, member)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_member ON chat_members(member);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(id UNINDEXED, text);
-- trigram tokenizer = substring matching, so a search for "מוכר" finds "מוכרת"
-- (Hebrew has no stemmer in fts5's default tokenizer).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_trigram USING fts5(id UNINDEXED, text, tokenize='trigram');
CREATE TABLE IF NOT EXISTS reminders (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  text     TEXT NOT NULL,
  due_ts   INTEGER NOT NULL,
  fired    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(fired, due_ts);
-- A chat's timezone while it is away from home ("we're in Boston"); no row = home.
CREATE TABLE IF NOT EXISTS chat_tz (chat_jid TEXT PRIMARY KEY, tz TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0);
-- Per-chat daily tokens, kept for guest groups (their own cap on top of the global one).
CREATE TABLE IF NOT EXISTS chat_usage (day TEXT NOT NULL, chat_jid TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, chat_jid));
`

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface StoreOptions {
  embedDim?: number
}

// Build a safe FTS5 MATCH expression: tokenize (Unicode-aware, so Hebrew works),
// quote each token, OR them. Avoids FTS5 syntax errors from raw user input.
function ftsQuery(query: string): string | null {
  const toks = query.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  if (!toks || toks.length === 0) return null
  return toks.map((t) => `"${t}"`).join(' OR ')
}

// Trigram MATCH needs tokens ≥3 chars; each becomes a substring match (OR'd).
function trigramQuery(query: string): string | null {
  const toks = query.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((t) => t.length >= 3)
  if (!toks || toks.length === 0) return null
  return toks.map((t) => `"${t}"`).join(' OR ')
}

export function openStore(dbPath: string, opts: StoreOptions = {}): Store {
  const embedDim = opts.embedDim ?? 1024
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  sqliteVec.load(db)
  db.exec(BASE_SCHEMA)
  // Migration: scheduled TASKS (an instruction run through the brain at fire time) +
  // recurrence. Additive columns on the existing reminders table; ignore "already exists".
  for (const col of ['instruction TEXT', 'recurrence TEXT']) {
    try { db.exec(`ALTER TABLE reminders ADD COLUMN ${col}`) } catch { /* column already present */ }
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(message_id TEXT PRIMARY KEY, embedding float[${embedDim}])`,
  )
  // Backfill the trigram index for messages indexed before it existed (one-time).
  if ((db.prepare(`SELECT COUNT(*) AS n FROM messages_trigram`).get() as { n: number }).n === 0) {
    db.exec(`INSERT INTO messages_trigram(id, text) SELECT id, text FROM messages WHERE text <> ''`)
  }

  const insert = db.prepare(
    `INSERT INTO messages (id, chat_jid, sender_jid, sender_name, text, ts, from_me, source)
     VALUES (@id, @chatJid, @senderJid, @senderName, @text, @ts, @fromMe, @source)
     ON CONFLICT(id) DO NOTHING`,
  )
  const selById = db.prepare(`SELECT * FROM messages WHERE id = ?`)
  const count = db.prepare(`SELECT COUNT(*) AS n FROM messages`)
  const upContact = db.prepare(
    `INSERT INTO contacts (jid, name) VALUES (?, ?)
     ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
  )
  const selContact = db.prepare(`SELECT name FROM contacts WHERE jid = ?`)
  const upChat = db.prepare(
    `INSERT INTO chats (jid, name) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
  )
  const selChat = db.prepare(`SELECT name FROM chats WHERE jid = ?`)
  const selTz = db.prepare(`SELECT tz FROM chat_tz WHERE chat_jid = ?`)
  const upTz = db.prepare(`INSERT INTO chat_tz (chat_jid, tz) VALUES (?, ?) ON CONFLICT(chat_jid) DO UPDATE SET tz = excluded.tz`)
  const delTz = db.prepare(`DELETE FROM chat_tz WHERE chat_jid = ?`)
  const ftsDelete = db.prepare(`DELETE FROM messages_fts WHERE id = ?`)
  const ftsInsert = db.prepare(`INSERT INTO messages_fts (id, text) VALUES (?, ?)`)
  const triDelete = db.prepare(`DELETE FROM messages_trigram WHERE id = ?`)
  const triInsert = db.prepare(`INSERT INTO messages_trigram (id, text) VALUES (?, ?)`)
  const triMatch = db.prepare(
    `SELECT id, rank AS score FROM messages_trigram WHERE messages_trigram MATCH ? ORDER BY rank LIMIT ?`,
  )
  const vecInsert = db.prepare(
    `INSERT OR REPLACE INTO vec_messages (message_id, embedding) VALUES (?, ?)`,
  )
  const ftsMatch = db.prepare(
    `SELECT id, rank AS score FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
  )
  const vecMatch = db.prepare(
    `SELECT message_id AS id, distance FROM vec_messages WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
  )
  const recentAll = db.prepare(`SELECT * FROM messages ORDER BY ts DESC LIMIT ?`)
  const oldestAll = db.prepare(`SELECT * FROM messages ORDER BY ts ASC LIMIT ?`)
  const recentByMe = db.prepare(`SELECT * FROM messages WHERE from_me = ? ORDER BY ts DESC LIMIT ?`)
  const inRange = db.prepare(
    `SELECT * FROM messages WHERE ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?`,
  )
  // Chat-scoped variants: restrict to the ONE chat the request came from (the ACL).
  // Feed-owner in their private DM passes no scope → sees everything (unscoped above).
  const INSCOPE = `chat_jid = @member`
  const recentAllScoped = db.prepare(`SELECT * FROM messages WHERE ${INSCOPE} ORDER BY ts DESC LIMIT @lim`)
  const recentByMeScoped = db.prepare(`SELECT * FROM messages WHERE from_me = @fromMe AND ${INSCOPE} ORDER BY ts DESC LIMIT @lim`)
  const oldestAllScoped = db.prepare(`SELECT * FROM messages WHERE ${INSCOPE} ORDER BY ts ASC LIMIT @lim`)
  const inRangeScoped = db.prepare(`SELECT * FROM messages WHERE ts BETWEEN @from AND @to AND ${INSCOPE} ORDER BY ts ASC LIMIT @lim`)
  // chat membership
  const memAdd = db.prepare(`INSERT INTO chat_members (chat_jid, member) VALUES (?, ?) ON CONFLICT DO NOTHING`)
  const memDel = db.prepare(`DELETE FROM chat_members WHERE chat_jid = ? AND member = ?`)
  const memClear = db.prepare(`DELETE FROM chat_members WHERE chat_jid = ?`)
  const memList = db.prepare(`SELECT member FROM chat_members WHERE chat_jid = ?`)
  const memChats = db.prepare(`SELECT chat_jid FROM chat_members WHERE member = ?`)
  // newest N in a chat within the time window, returned chronologically (ASC)
  const byChat = db.prepare(
    `SELECT * FROM (SELECT * FROM messages WHERE chat_jid = ? AND ts >= ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC`,
  )
  // page back by position: skip `offset` newest, take `limit`; return chronological
  const pageChatStmt = db.prepare(
    `SELECT * FROM (SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ? OFFSET ?) ORDER BY ts ASC`,
  )
  const dedGroups = db.prepare(
    `SELECT chat_jid FROM messages WHERE source = 'dedicated' AND chat_jid LIKE '%@g.us' GROUP BY chat_jid ORDER BY MAX(ts) DESC`,
  )
  const addRem = db.prepare(`INSERT INTO reminders (chat_jid, owner_id, text, due_ts, instruction, recurrence) VALUES (?, ?, ?, ?, ?, ?)`)
  const dueRem = db.prepare(`SELECT id, chat_jid AS chatJid, owner_id AS ownerId, text, instruction, recurrence, due_ts AS dueTs FROM reminders WHERE fired = 0 AND due_ts <= ? ORDER BY due_ts LIMIT 50`)
  const fireRem = db.prepare(`UPDATE reminders SET fired = 1 WHERE id = ?`)
  const reschedRem = db.prepare(`UPDATE reminders SET due_ts = ? WHERE id = ?`)
  const chatRem = db.prepare(`SELECT id, chat_jid AS chatJid, owner_id AS ownerId, text, instruction, recurrence, due_ts AS dueTs FROM reminders WHERE fired = 0 AND chat_jid = ? ORDER BY due_ts`)
  const cancelRem = db.prepare(`UPDATE reminders SET fired = 1 WHERE id = @id AND chat_jid = @chat AND fired = 0 AND (@owner IS NULL OR owner_id = @owner)`)
  const addUse = db.prepare(`INSERT INTO usage (day, tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens`)
  const getUse = db.prepare(`SELECT tokens FROM usage WHERE day = ?`)
  const addChatUse = db.prepare(`INSERT INTO chat_usage (day, chat_jid, tokens) VALUES (?, ?, ?) ON CONFLICT(day, chat_jid) DO UPDATE SET tokens = tokens + excluded.tokens`)
  const getChatUse = db.prepare(`SELECT tokens FROM chat_usage WHERE day = ? AND chat_jid = ?`)
  const unindexed = db.prepare(
    `SELECT m.id, m.text FROM messages m
     LEFT JOIN vec_messages v ON v.message_id = m.id
     WHERE v.message_id IS NULL AND m.text <> '' LIMIT ?`,
  )

  // Resolve a display name: stored push-name → address-book contact → the phone
  // number from the JID (97% of history-synced messages have no push-name, so this
  // turns "Unknown" into a real name or at least a number for phone JIDs).
  const resolveName = (senderName: string | null, jid: string): string | undefined => {
    if (senderName) return senderName
    const c = (selContact.get(jid) as { name: string } | undefined)?.name
    if (c) return c
    return jid.endsWith('@s.whatsapp.net') ? `+${jid.split('@')[0]}` : undefined
  }

  const rowToMsg = (r: any): StoredMessage | undefined =>
    r && {
      id: r.id, chatJid: r.chat_jid,
      // Name the CHAT: a group's subject, or (for a 1:1) the other party — so a result
      // shows which conversation it's from / who a sent message went TO.
      chatName: isGroupJid(r.chat_jid)
        ? (selChat.get(r.chat_jid) as { name: string } | undefined)?.name
        : resolveName(null, r.chat_jid), // 1:1 → the other party
      senderJid: r.sender_jid,
      senderName: resolveName(r.sender_name, r.sender_jid), text: r.text, ts: r.ts,
      fromMe: Boolean(r.from_me), source: r.source,
    }

  return {
    ingest(msg) {
      const info = insert.run({
        ...msg,
        senderName: msg.senderName ?? null,
        fromMe: msg.fromMe ? 1 : 0,
      })
      return info.changes > 0
    },
    getMessage(id) { return rowToMsg(selById.get(id)) },
    recentMessages(limit, opts) {
      const s = opts?.chatScope
      const rows =
        opts?.fromMe === undefined
          ? s
            ? recentAllScoped.all({ member: s, lim: limit })
            : recentAll.all(limit)
          : s
            ? recentByMeScoped.all({ fromMe: opts.fromMe ? 1 : 0, member: s, lim: limit })
            : recentByMe.all(opts.fromMe ? 1 : 0, limit)
      return (rows as any[]).map(rowToMsg).filter((m): m is StoredMessage => !!m)
    },
    oldestMessages(limit, opts) {
      const rows = opts?.chatScope
        ? oldestAllScoped.all({ member: opts.chatScope, lim: limit })
        : oldestAll.all(limit)
      return (rows as any[]).map(rowToMsg).filter((m): m is StoredMessage => !!m)
    },
    messagesInRange(fromTs, toTs, limit, opts) {
      const rows = opts?.chatScope
        ? inRangeScoped.all({ from: fromTs, to: toTs, member: opts.chatScope, lim: limit })
        : inRange.all(fromTs, toTs, limit)
      return (rows as any[]).map(rowToMsg).filter((m): m is StoredMessage => !!m)
    },
    setChatMembers(chatJid, members) {
      const tx = db.transaction((jid: string, ms: string[]) => {
        memClear.run(jid)
        for (const m of ms) memAdd.run(jid, m)
      })
      tx(chatJid, members)
    },
    addChatMembers(chatJid, members) { for (const m of members) memAdd.run(chatJid, m) },
    removeChatMembers(chatJid, members) { for (const m of members) memDel.run(chatJid, m) },
    chatMembers(chatJid) { return (memList.all(chatJid) as { member: string }[]).map((r) => r.member) },
    chatsForMember(member) { return (memChats.all(member) as { chat_jid: string }[]).map((r) => r.chat_jid) },
    recentByChat(chatJid, limit, sinceTs) {
      return (byChat.all(chatJid, sinceTs, limit) as any[])
        .map(rowToMsg)
        .filter((m): m is StoredMessage => !!m)
    },
    messagesByChatPaged(chatJid, offset, limit) {
      return (pageChatStmt.all(chatJid, limit, offset) as any[])
        .map(rowToMsg)
        .filter((m): m is StoredMessage => !!m)
    },
    dedicatedGroups() {
      return (dedGroups.all() as { chat_jid: string }[]).map((r) => r.chat_jid)
    },
    getMessagesByIds(ids) {
      const byId = new Map<string, StoredMessage>()
      for (const id of ids) {
        const m = rowToMsg(selById.get(id))
        if (m) byId.set(id, m)
      }
      // preserve caller's (ranked) order
      return ids.map((id) => byId.get(id)).filter((m): m is StoredMessage => !!m)
    },
    countMessages() { return (count.get() as { n: number }).n },
    upsertContact(jid, name) { upContact.run(jid, name) },
    getContactName(jid) { return (selContact.get(jid) as { name: string } | undefined)?.name },
    findJidByName(name) {
      // Match a contact by full name OR first word (case-insensitive); only link on a
      // UNIQUE hit so an ambiguous name never mislinks.
      const q = name.trim().toLowerCase()
      const hits = (db.prepare(`SELECT jid, name FROM contacts WHERE name IS NOT NULL`).all() as { jid: string; name: string }[])
        .filter((c) => { const n = c.name.toLowerCase(); return n === q || n.split(/\s+/)[0] === q })
      return hits.length === 1 ? hits[0]!.jid : undefined
    },
    upsertChatName(jid, name) { upChat.run(jid, name) },
    getChatName(jid) { return (selChat.get(jid) as { name: string } | undefined)?.name },
    getChatTz(jid) { return (selTz.get(jid) as { tz: string } | undefined)?.tz },
    setChatTz(jid, tz) { if (tz) upTz.run(jid, tz); else delTz.run(jid) },
    // Label a conversation: a group's subject, or (for a 1:1) the other party's name/phone.
    chatLabel(jid) { return isGroupJid(jid) ? (selChat.get(jid) as { name: string } | undefined)?.name : resolveName(null, jid) },
    indexMessage(id, text, embedding) {
      ftsDelete.run(id)
      ftsInsert.run(id, text)
      triDelete.run(id)
      triInsert.run(id, text)
      vecInsert.run(id, JSON.stringify(embedding))
    },
    ftsSearch(query, k) {
      const match = ftsQuery(query)
      if (!match) return []
      return ftsMatch.all(match, k) as { id: string; score: number }[]
    },
    trigramSearch(query, k) {
      const match = trigramQuery(query)
      if (!match) return []
      return triMatch.all(match, k) as { id: string; score: number }[]
    },
    vecSearch(embedding, k) {
      return vecMatch.all(JSON.stringify(embedding), k) as { id: string; distance: number }[]
    },
    getUnindexedMessages(limit) {
      return unindexed.all(limit) as { id: string; text: string }[]
    },
    // Drop whole chats (rows + their search index); `chatJid` may be a LIKE pattern. Returns the
    // deleted row ids (callers map them to saved media).
    deleteChats(chatJid) {
      const ids = (db.prepare(`SELECT id FROM messages WHERE chat_jid LIKE ?`).all(chatJid) as { id: string }[]).map((r) => r.id)
      const del = db.transaction(() => {
        for (const id of ids) {
          ftsDelete.run(id)
          triDelete.run(id)
          db.prepare(`DELETE FROM vec_messages WHERE message_id = ?`).run(id)
        }
        db.prepare(`DELETE FROM messages WHERE chat_jid LIKE ?`).run(chatJid)
      })
      del()
      return ids
    },
    addReminder(r) { addRem.run(r.chatJid, r.ownerId, r.text ?? '', r.dueTs, r.instruction ?? null, r.recurrence ?? null) },
    dueReminders(nowTs) { return dueRem.all(nowTs) as any },
    markFired(id) { fireRem.run(id) },
    rescheduleReminder(id, nextTs) { reschedRem.run(nextTs, id) },
    remindersInChat(chatJid) { return chatRem.all(chatJid) as any },
    cancelReminder(id, chatJid, ownerId) { return cancelRem.run({ id, chat: chatJid, owner: ownerId ?? null }).changes > 0 },
    addUsage(tokens, chatJid) {
      addUse.run(today(), tokens)
      if (chatJid) addChatUse.run(today(), chatJid, tokens)
    },
    usageToday(chatJid) {
      const row = chatJid ? getChatUse.get(today(), chatJid) : getUse.get(today())
      return (row as { tokens: number } | undefined)?.tokens ?? 0
    },
    close() { db.close() },
  }
}
