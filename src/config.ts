export interface Config {
  dedicatedNumber: string // E.164 digits only, no '+', e.g. 972500000000
  credsDir: string
  dbPath: string
  memoryDir: string
  personalNumber?: string // optional: the owner's real number (read-only sensor)
  personalCredsDir: string
  owners: string[] // bare phone digits — full corpus (you + partner)
  allowlist: string[] // additional family phone digits allowed a brain response
  allowedGroups: string[] // group jids Gizmo may respond in; empty = none
  familyGroups: string[] // group jids that get owner tools + family context; any other group is a guest group
  householdGroup?: string // the owners' private group — jid or name; authoritative for "our group"
  brainModel: string // Anthropic model id for the hosted brain
  googleClientId?: string
  googleClientSecret?: string
  googleTokenPath: string
  googleOwner?: string // bare phone allowed Google tools (YOU alone; defaults to owners[0])
  ownerNames: Record<string, string> // bare phone -> known name (Dan/Alex) so the brain knows WHO is speaking in a group
  dailyTokenBudget: number // soft global daily cap on brain tokens
  guestDailyTokenBudget: number // per guest group, on top of the global cap
  guestDailyImages: number // paid image calls per guest group per day, on top of the global 40
  turnDebounceMs: number // window to coalesce a burst of messages into one reply turn
  historyLimit: number // max recent messages of this chat fed to the model per call
  historyWindowHours: number // don't feed messages older than this (hours)
  burstGapMinutes: number // a gap larger than this gets a "— Xh later —" marker in the in-context history
  healthcheckUrl?: string // dead-man's-switch ping (Healthchecks.io etc.)
  claudeCodeToken?: string // Claude on the owner's subscription; also powers the worker
  githubAppId?: string // self-coding via the coder service (GitHub App)
  workerUrl: string
  workerKey?: string // shared secret for the worker's HTTP API (GIZMO_WORKER_KEY, same value in gizmo + worker)
  coderUrl: string
  coderSecret?: string // shared secret for the coder's HTTP API
}

const csv = (v?: string): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// "972...:Dan,972...:Alex" -> { '972...': 'Dan', ... }
const nameMap = (v?: string): Record<string, string> =>
  Object.fromEntries(csv(v).map((pair) => pair.split(':').map((s) => s.trim())).filter(([p, n]) => p && n))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dedicatedNumber = env.GIZMO_DEDICATED_NUMBER
  if (!dedicatedNumber) throw new Error('GIZMO_DEDICATED_NUMBER is required')
  return {
    dedicatedNumber,
    credsDir: env.GIZMO_CREDS_DIR ?? 'data/creds/dedicated',
    dbPath: env.GIZMO_DB_PATH ?? 'data/gizmo.db',
    memoryDir: env.GIZMO_MEMORY_DIR ?? 'data/memory',
    personalNumber: env.GIZMO_PERSONAL_NUMBER || undefined,
    personalCredsDir: env.GIZMO_PERSONAL_CREDS_DIR ?? 'data/creds/personal',
    owners: csv(env.GIZMO_OWNERS),
    allowlist: csv(env.GIZMO_ALLOWLIST),
    allowedGroups: csv(env.GIZMO_ALLOWED_GROUPS), // group jids Gizmo may respond in; empty = none
    familyGroups: csv(env.GIZMO_FAMILY_GROUPS),
    householdGroup: env.GIZMO_HOUSEHOLD_GROUP?.trim() || undefined,

    brainModel: env.GIZMO_BRAIN_MODEL ?? 'claude-sonnet-4-6',
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    googleTokenPath: env.GOOGLE_TOKEN_PATH ?? 'data/creds/google.json',
    googleOwner: env.GIZMO_GOOGLE_OWNER || undefined,
    ownerNames: nameMap(env.GIZMO_OWNER_NAMES),
    dailyTokenBudget: Number(env.GIZMO_DAILY_TOKEN_BUDGET ?? 2_000_000),
    guestDailyTokenBudget: Number(env.GIZMO_GUEST_DAILY_TOKEN_BUDGET ?? 200_000),
    guestDailyImages: Number(env.GIZMO_GUEST_DAILY_IMAGES ?? 10),
    turnDebounceMs: Number(env.GIZMO_TURN_DEBOUNCE_MS ?? 1500),
    historyLimit: Number(env.GIZMO_HISTORY_LIMIT ?? 25),
    historyWindowHours: Number(env.GIZMO_HISTORY_WINDOW_HOURS ?? 48),
    burstGapMinutes: Number(env.GIZMO_BURST_GAP_MIN ?? 120),
    healthcheckUrl: env.GIZMO_HEALTHCHECK_URL || undefined,
    claudeCodeToken: env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
    githubAppId: env.GIZMO_APP_ID || undefined,
    workerUrl: env.GIZMO_WORKER_URL ?? 'http://worker:8788',
    workerKey: env.GIZMO_WORKER_KEY || undefined,
    coderUrl: env.GIZMO_CODER_URL ?? 'http://coder:8787',
    coderSecret: env.GIZMO_CODER_SECRET || undefined,
  }
}
