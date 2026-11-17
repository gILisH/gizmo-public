export type MessageSource = 'dedicated' | 'personal' | 'export'

export interface StoredMessage {
  id: string
  chatJid: string
  chatName?: string // group/chat name, resolved when known
  senderJid: string
  senderName?: string
  text: string
  ts: number
  fromMe: boolean
  source: MessageSource
}

export type Reminder = { id: number; chatJid: string; ownerId: string; text: string; instruction: string | null; recurrence: string | null; dueTs: number }

export interface Store {
  ingest(msg: StoredMessage): boolean
  getMessage(id: string): StoredMessage | undefined
  getMessagesByIds(ids: string[]): StoredMessage[]
  // `chatScope` (a canonical phone/jid) restricts to chats that member belongs to —
  // the ACL filter. Omit for the feed-owner, who sees everything.
  recentMessages(limit: number, opts?: { fromMe?: boolean; chatScope?: string }): StoredMessage[]
  // the OLDEST messages in the corpus (chronological, earliest first)
  oldestMessages(limit: number, opts?: { chatScope?: string }): StoredMessage[]
  messagesInRange(fromTs: number, toTs: number, limit: number, opts?: { chatScope?: string }): StoredMessage[]
  // recent turns of one chat (chronological), for conversational continuity
  recentByChat(chatJid: string, limit: number, sinceTs: number): StoredMessage[]
  // deterministic pagination back through one chat: skip `offset` newest, take `limit`
  messagesByChatPaged(chatJid: string, offset: number, limit: number): StoredMessage[]
  // groups the dedicated (bot) socket is in — the household group(s), most-active first
  dedicatedGroups(): string[]
  countMessages(): number
  deleteChats(chatJidLike: string): string[] // delete a chat's rows + FTS/vector entries; returns the ids
  upsertContact(jid: string, name: string): void
  getContactName(jid: string): string | undefined
  findJidByName(name: string): string | undefined // reverse lookup: a contact whose name matches (unique), else undefined
  upsertChatName(jid: string, name: string): void
  getChatName(jid: string): string | undefined
  getChatTz(jid: string): string | undefined
  setChatTz(jid: string, tz: string | null): void // null = back to home
  chatLabel(jid: string): string | undefined
  // per-chat membership ACL
  setChatMembers(chatJid: string, members: string[]): void
  addChatMembers(chatJid: string, members: string[]): void
  removeChatMembers(chatJid: string, members: string[]): void
  chatMembers(chatJid: string): string[]
  chatsForMember(member: string): string[]
  // search index (Phase 3)
  indexMessage(id: string, text: string, embedding: number[]): void
  getUnindexedMessages(limit: number): { id: string; text: string }[]
  ftsSearch(query: string, k: number): { id: string; score: number }[]
  trigramSearch(query: string, k: number): { id: string; score: number }[]
  vecSearch(embedding: number[], k: number): { id: string; distance: number }[]
  // reminders + scheduled tasks. `text` = fixed message (no LLM); `instruction` = run
  // through the brain at fire time. `recurrence` = hourly|daily|weekly (null = one-shot).
  addReminder(r: { chatJid: string; ownerId: string; text?: string; dueTs: number; instruction?: string; recurrence?: string }): void
  dueReminders(nowTs: number): Reminder[]
  markFired(id: number): void
  rescheduleReminder(id: number, nextTs: number): void
  remindersInChat(chatJid: string): Reminder[] // pending (unfired) ones, soonest first
  // Cancel a pending reminder in THIS chat; with ownerId, only if that person set it. true = cancelled.
  cancelReminder(id: number, chatJid: string, ownerId?: string): boolean
  // daily token budget (Phase: hardening)
  addUsage(tokens: number, chatJid?: string): void // always counts globally; with chatJid, also for that chat
  usageToday(chatJid?: string): number // global, or one chat's (only chats passed to addUsage are counted)
  close(): void
}
