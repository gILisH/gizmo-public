import type { LanguageModel } from 'ai'
import type { Person, RelType } from '../people'
import type { EditorName } from '../media/edit'
import type { Memory } from '../memory'
import type { Snippet } from '../search'
import type { StoredMessage, Reminder } from '../store/types'
import type { FileStore } from '../files'
import type { Ledger } from '../ledger'
import type { makePostStager } from '../groups'

// Everything the brain's tools may need, injected by the composition root (app.ts).
// Optional fields are capability flags: a tool is only exposed when its dep is present
// (e.g. no `webSearch` dep → no web_search tool), so the model never sees a dead tool.
export interface BrainDeps {
  model: LanguageModel
  memory: Memory
  search: (query: string, opts?: { limit?: number; from?: string; after?: number; before?: number; chatScope?: string; sort?: 'relevance' | 'recent' }) => Promise<Snippet[]>
  recent: (limit: number, opts?: { fromMe?: boolean; chatScope?: string }) => StoredMessage[]
  oldest: (limit: number, opts?: { chatScope?: string }) => StoredMessage[] // the earliest messages in the whole corpus
  range: (fromTs: number, toTs: number, limit: number, opts?: { chatScope?: string }) => StoredMessage[]
  pageChat: (chatJid: string, offset: number, limit: number) => StoredMessage[]
  setReminder: (r: { chatJid: string; ownerId: string; text?: string; dueTs: number; instruction?: string; recurrence?: string }) => void
  listReminders?: (chatJid: string) => Reminder[] // pending reminders/tasks in one chat
  cancelReminder?: (id: number, chatJid: string, ownerId?: string) => boolean // ownerId = only if they set it
  sendText: (chatJid: string, text: string) => Promise<void>
  sendMeme: (chatJid: string, template: string, top: string, bottom: string) => Promise<void>
  sendGif: (chatJid: string, query: string) => Promise<void>
  // Native WhatsApp message primitives (each optional = a capability the composition root wires).
  sendPoll?: (chatJid: string, question: string, options: string[]) => Promise<void>
  react?: (chatJid: string, emoji: string) => Promise<void> // react to the user's latest message
  sendLocation?: (chatJid: string, latitude: number, longitude: number, name?: string) => Promise<void>
  geocode?: (query: string) => Promise<{ lat: number; lng: number; label: string } | null> // place name/address → coords
  sendContact?: (chatJid: string, name: string, phone: string) => Promise<void>
  sendDocument?: (chatJid: string, file: Buffer, fileName: string, mimetype: string, caption?: string) => Promise<void>
  ledger?: Ledger // the kids' pocket-money ledger (ledger_add/balance/history)
  fxToIls?: (currency: string) => Promise<number> // ILS per 1 unit of a currency (configured or fetched)
  files?: FileStore // per-chat files Gizmo made (csv/xlsx/pdf/txt), kept as editable source
  replyQuote?: (chatJid: string, text: string) => Promise<void> // reply quoting the user's latest message
  editLastMessage?: (chatJid: string, text: string) => Promise<void> // edit Gizmo's own latest message
  deleteLastMessage?: (chatJid: string) => Promise<void> // delete Gizmo's own latest message
  webSearch?: (query: string) => Promise<string> // live web search (provider-agnostic function tool)
  webFetch?: (url: string) => Promise<string> // read a full page (browser-rendered, gets past soft-blocks)
  sendWebMedia?: (chatJid: string, url: string, caption?: string) => Promise<string> // download a photo/file from the web + send the real thing
  generateImage?: (chatJid: string, prompt: string) => Promise<void> // create + send an AI image
  sendSavedPhoto?: (chatJid: string, query: string, chatScope?: string) => Promise<string> // in-chat re-send: resolve the referenced photo + send it here
  resolvePhoto?: (query: string, sourceChatJid?: string, chatScope?: string) => Promise<Buffer | null> // find the EXACT photo the owner means (a reply's quoted image / one just sent → the chat's stash; else history by description)
  sendPhotoBytes?: (chatJid: string, image: Buffer) => Promise<void> // send already-resolved image bytes to a chat
  editImage?: (chatJid: string, instruction: string, model?: EditorName, photos?: number) => Promise<string> // edit/compose the photo(s) just sent (img2img; photos>1 = fuse)
  editKeepFace?: (chatJid: string, instruction: string) => Promise<string> // face-locked edit: regenerate everything but keep the face pixel-identical (FLUX.1 Fill)
  setAvatar?: (opts: { chatJid: string; description?: string }) => Promise<string> // owner-only: set Gizmo's profile pic
  enrollPerson?: (chatJid: string, name: string, opts: { aliases?: string[]; relation?: string; forceNew?: boolean }) => Promise<string> // owner-only: save recent photo(s) as a known person
  composeScene?: (chatJid: string, people: string[], scene: string) => Promise<string> // owner-only: place known people into a generated scene
  placeIntoPhoto?: (chatJid: string, people: string[], instruction: string) => Promise<string> // owner-only: add library people INTO an existing chat photo
  showPersonPhotos?: (chatJid: string, name: string) => Promise<string> // owner-only: send back a person's saved photos, numbered
  deletePersonPhoto?: (name: string, position: number) => string // owner-only: delete one saved photo by its shown number
  forgetPerson?: (name: string) => string // owner-only: delete a known person + their photos
  addPersonNames?: (name: string, extra: string[]) => string // owner-only: add aliases so more names resolve to one person
  setPersonRelation?: (person: string, relation: RelType, of: string) => string // owner-only: record a family edge
  setPersonHeight?: (name: string, cm: number) => string // owner-only: record real height → correct scene proportions
  listPeople?: () => Person[] // roster (no photos) for the system prompt
  listGroupPeople?: (chatJid: string) => Person[] // a guest group's own face roster (every member sees it)
  switchBrain?: (name: BrainName) => string // owner-only: flip the active model
  proposeChange?: { owner: string; start: (chatJid: string, request: string) => Promise<string> } // self-coding → a PR; `owner` alone may use it
  sandboxes?: { owner: string; stop: () => Promise<string[]>; pause: () => void; resume: () => void; paused: () => boolean } // the off switch for worker + coder; `owner` alone may use it
  claudeCode?: { owner: string; send: (chatJid: string, message: string, opts?: { photos?: string[]; chatScope?: string; fresh?: boolean }) => Promise<string>; status: () => Promise<string> } // Gizmo's Claude Code: one long-lived session Dan talks to through Gizmo; `owner` alone may use it
  switchImageModel?: (name: EditorName) => string // owner-only: flip the default image editor
  householdGroup: () => string | undefined // the you+Alex+Gizmo group jid, or undefined
  findGroup: (name?: string) => string | undefined // group by name → jid, among groups Gizmo is in (no name = household)
  chatName: (jid: string) => string | undefined // display name of a group/chat (for the confirm prompt)
  // Staged cross-chat send: post_to_group STAGES a send + its target name; the owner must
  // approve before confirmPost actually runs it. Keeps Gizmo from sending to the wrong chat.
  stagePost: (fromChat: string, targetName: string, run: () => Promise<void>, turnId: string) => void
  confirmPost: (fromChat: string, turnId: string) => Promise<string> // run the staged send (refused in the turn that staged it), or report none pending
  cancelPost: (fromChat: string) => string // discard the staged send
  // Injectable actions (claude_code, schedule_task) staged until the owner approves in a later turn.
  actions?: ReturnType<typeof makePostStager>
  sendVoiceNote?: (chatJid: string, text: string) => Promise<void> // TTS → voice note to any chat (if tts configured)
  soul: string
  maxSteps?: number
  getChatTz?: (chatJid: string) => string | undefined // a travelling chat's timezone; undefined = home
  setChatTz?: (chatJid: string, tz: string | null) => void
  // Extra tools resolved PER SPEAKER, so owner-only tools (e.g. Google) are only exposed
  // to the right person. Wired by the composition root; keeps the brain provider-agnostic.
  extraTools?: (ctx: { id: string; isOwner: boolean; inGroup: boolean; fromSandbox: boolean }) => Record<string, unknown>
}

export type { RelType }

export const BRAINS = ['claude', 'gemini', 'grok'] as const
export type BrainName = (typeof BRAINS)[number]

// Per-turn, per-speaker context every tool factory receives alongside deps + the
// canonical requester id. Owner-gating and ACL scoping are decided from this — never
// by the model.
export interface ToolCtx {
  isOwner?: boolean
  inGroup?: boolean
  chatJid?: string
  chatScope?: string // ACL: restrict history reads to this member's chats (omit = feed owner, all)
  guest?: boolean // a non-family group: no personal memory tools
  tz?: string // this chat's timezone (home unless it's travelling)
  fromSandbox?: boolean // a question from the Claude Code worker: read-only tools, no sends/Google/sandboxes
  turnId?: string // this turn's id: post_to_group stamps it so confirm_send can refuse a same-turn confirm
}

export interface ConvMessage {
  role: 'user' | 'assistant'
  content: string
}
