import { existsSync, readFileSync } from 'node:fs'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { xai } from '@ai-sdk/xai'
import { loadConfig } from './config'
import { BaileysTransport } from './transport/baileys'
import { ReadOnlyBaileysTransport } from './transport/readonly'
import { makeEchoHandler } from './handler'
import { openStore } from './store'
import { makeIngestHandler } from './ingest/handler'
import { OllamaEmbedder } from './search/embedder'
import { backfill } from './search/backfill'
import { makeSearch } from './search'
import { webSearchFromEnv, webFetchFromEnv, makeSendWebMedia } from './search/web'
import { editorsFromEnv, fluxGenerateImage, fluxFillImage, type EditorName } from './media/edit'
import { detectFaceBox, buildKeepFaceMask } from './media/facemask'
import { makePeopleImageTools } from './media/tools'
import { makeMediaLibrary } from './media/saved-photo'
import { geocode } from './media/geocode'
import { makePhotoStash } from './media/photo-stash'
import { makeDailyCap, makeChatCap } from './media/cap'
import { openMemory } from './memory'
import { openPeople } from './people'
import { isGuestGroup } from './policy'
import { openFileStore } from './files'
import { openLedger, makeFx, parseRates, fetchIlsRate } from './ledger'
import { dirname, join } from 'node:path'
import { makeAccess, buildResolver } from './access'
import { makeBrain, type BrainDeps } from './brain'
import { BRAINS, type BrainName } from './brain/types'
import { makeClaudeCodeBrain } from './brain/claude-code'
import { makeCoderClient } from './coder/client'
import { withCoderKey } from './coder/auth'
import { makeClaudeCodeLine } from './worker/client'
import { findPhotos, MAX_PHOTOS } from './worker/photos'
import { makeFulfil, makePeopleGrants } from './worker/fulfil'
import { makeSandboxControl } from './worker/control'
import { withWorkerKey } from './worker/auth'
import { authorizedClient, hasToken } from './google/auth'
import { makeGoogleTools, openCreatedIds } from './google/tools'
import { groqTranscribe, tesseractOcr, pdfText, docText, geminiVision } from './media/providers'
import { ttsFromEnv, synthesize, toVoiceNote } from './voice/tts'
import { resolveGroup, pickHouseholdGroup, makePostStager, trustedGroups, groupLabel } from './groups'
import { makeResponder } from './respond'
import { fireDueReminders, nonOverlapping } from './schedule'
import { fetchMeme, fetchGif, fetchAiImage } from './fun'
import type { MediaDeps } from './media'

const mediaDeps: MediaDeps = { transcribe: groqTranscribe, ocr: tesseractOcr, pdfText, docText }

const BACKFILL_INTERVAL_MS = 30_000

const DEFAULT_SOUL = `You are Gizmo, a personal WhatsApp assistant for a family.
You are warm, concise, and practical. You reply in the language the person used
(Hebrew or English). Use searchHistory to answer questions about past messages,
and remember durable facts about the person you're talking to.

You can also search the live internet (web_search) and read web pages (web_fetch)
for current information not in the person's history — news, prices, facts, links
they send. Prefer their WhatsApp history for personal questions; use the web for
the wider world.

Formatting: you are on WhatsApp. For emphasis use WhatsApp markup — *single
asterisks* for bold, _underscores_ for italic. NEVER use Markdown (** or ## or
backticks). Keep formatting minimal; prefer clean plain text over decorating
every phrase.`

function loadSoul(): string {
  // SOUL.md is tracked (version-controlled personality); travels to the droplet.
  return existsSync('SOUL.md') ? readFileSync('SOUL.md', 'utf8') : DEFAULT_SOUL
}

async function main() {
  const config = loadConfig()
  const store = openStore(config.dbPath)
  // Most-recent photos the owner sent per chat (for edit/enroll/place/set_avatar).
  // TTL-scoped so photos from one task don't leak into the next (e.g. an earlier
  // "put Shira in this pic" flow contaminating a later "this is Itai" enroll).
  const lastImageByChat = makePhotoStash()
  // Off switch for the worker + coder sandboxes; the pause flag lives on /data so deploys keep it.
  const coderFetch = withCoderKey(config.coderUrl, config.coderSecret)
  const sandboxes = makeSandboxControl({
    urls: { worker: config.workerUrl, coder: config.coderUrl },
    flagPath: join(dirname(config.memoryDir), 'sandboxes-paused'),
    fetch: withWorkerKey(config.workerUrl, config.workerKey, coderFetch), // both sandboxes: each wrapper keys only its own URL
  })
  const PAUSED = 'paused: tasks and code changes are switched off; he can turn them back on (stop_tasks action resume)'
  const embedder = new OllamaEmbedder()
  const memory = openMemory(config.memoryDir)
  const people = openPeople(join(dirname(config.memoryDir), 'people')) // sibling of memory/ under data/
  // A guest group's faces live in their own library (data/people-groups/<jid>/), so family
  // faces never reach a guest group and guests never land in the family roster.
  const groupPeople = new Map<string, ReturnType<typeof openPeople>>()
  const peopleFor = (chatJid: string) => {
    if (!/^[\w.-]+@g\.us$/.test(chatJid) || !isGuestGroup({ isGroup: true, chatJid, familyGroups: config.familyGroups ?? [] })) return people
    if (!groupPeople.has(chatJid)) groupPeople.set(chatJid, openPeople(join(dirname(config.memoryDir), 'people-groups', chatJid)))
    return groupPeople.get(chatJid)!
  }
  const files = openFileStore(join(dirname(config.memoryDir), 'files'))
  // The kids' pocket-money ledger (data/ledger.json). EDIT ME: your kids' names + nicknames.
  const ledger = openLedger(join(dirname(config.memoryDir), 'ledger.json'), {
    kids: [
      { name: 'Eden', aliases: ['עדן', 'עֵדֶן'] },
      { name: 'Omer', aliases: ['עומר', 'עומרי', 'Omri'] },
    ],
  })
  // ILS conversion: GIZMO_FX_RATES ("USD=3.7,EUR=4.05") wins; otherwise a live rate, cached.
  const fxToIls = makeFx({ fixed: parseRates(process.env.GIZMO_FX_RATES), fetchRate: fetchIlsRate })
  // Persist every image Gizmo sees (both sockets) so it can re-send them later. Keyed by
  // WhatsApp msg id under data/media/. `search` maps a description back to the row → the file.
  const mediaLibrary = makeMediaLibrary(join(dirname(config.dbPath), 'media'))
  const persistImage = mediaLibrary.persist
  const { search: corpusSearch } = makeSearch(store, embedder)
  const resolver = buildResolver({
    credsDirs: [config.credsDir, config.personalCredsDir],
    lidMapDir: config.personalCredsDir, // per-owner lid-mapping-<phone>.json
    ownerPhones: [...config.owners, ...config.allowlist],
  })
  const access = makeAccess({ owners: config.owners, allowlist: config.allowlist }, resolver)
  // The personal read-only feed belongs to this owner (Dan); only they may search it.
  const feedOwner = config.googleOwner ?? config.owners[0]
  // Seed owner display names so the owner's OWN sent messages resolve to their name.
  for (const [phone, name] of Object.entries(config.ownerNames)) store.upsertContact(`${phone}@s.whatsapp.net`, name)
  // A person's stable id is their phone: map @lid → phone jid (for owners the resolver
  // knows), so the same person collapses to ONE id across sockets/@lid/phone.
  const botJid = `${config.dedicatedNumber}@s.whatsapp.net`
  const canonicalJid = (jid: string) => {
    const p = resolver.toPhone(jid)
    // Gizmo's own outbound (echoed back through the personal socket) → the same 'gizmo'
    // sentinel we record its turns under, so the two copies dedup to one.
    if (jid === botJid || p === config.dedicatedNumber) return 'gizmo'
    return p ? `${p}@s.whatsapp.net` : jid
  }
  // Corpus search excludes the bot's own turns (its answers aren't recallable history).
  const search = (q: string, opts?: Parameters<typeof corpusSearch>[1]) =>
    corpusSearch(q, { ...opts, excludeSenders: [botJid, 'gizmo', ...(opts?.excludeSenders ?? [])] })

  // Brain only if a hosted key is present; else fall back to echo so the loop
  // still works locally without a key.
  // Google tools (owner-only) — built if configured + authorized.
  const googleCfg =
    config.googleClientId && config.googleClientSecret
      ? { clientId: config.googleClientId, clientSecret: config.googleClientSecret, tokenPath: config.googleTokenPath }
      : null
  const googleTools = googleCfg && hasToken(googleCfg.tokenPath) ? makeGoogleTools(authorizedClient(googleCfg), openCreatedIds(join(dirname(config.memoryDir), 'google-created.json'))) : null
  const googleOwner = feedOwner // the same person: the personal feed and Google both belong to GIZMO_GOOGLE_OWNER
  if (googleTools) console.log('google tools enabled for owner', googleOwner)

  const tts = ttsFromEnv() // voice-out (ElevenLabs) if ELEVENLABS_API_KEY set
  // Web search as a provider-agnostic FUNCTION tool (Tavily), so it works under both
  // Gemini and Claude — unlike Anthropic's native web tool which Gemini can't use.
  const webSearch = webSearchFromEnv()
  if (webSearch) console.log('web search enabled (tavily)')
  const webFetch = webFetchFromEnv() // read full pages via Jina Reader (browser-rendered)
  // Every paid image call (edit, generate, face-lock) shares one daily cap, whichever path asks.
  const capped = makeDailyCap(40)
  // …and each guest group gets its own smaller daily cap on top (chat-first image actions).
  const guestCapped = makeChatCap(config.guestDailyImages, (chatJid) => isGuestGroup({ isGroup: /@g\.us$/.test(chatJid), chatJid, familyGroups: config.familyGroups ?? [] }))
  const guestCapImageTools = <T extends Partial<Record<'editImage' | 'editKeepFace' | 'composeScene' | 'placeIntoPhoto', ((chatJid: string, ...a: any[]) => Promise<string>) | undefined>>>(t: T): T => {
    for (const k of ['editImage', 'editKeepFace', 'composeScene', 'placeIntoPhoto'] as const) if (t[k]) (t as any)[k] = guestCapped(t[k]!)
    return t
  }
  const imageEditors = Object.fromEntries(Object.entries(editorsFromEnv()).map(([n, e]) => [n, capped(e)])) as ReturnType<typeof editorsFromEnv> // img2img: gemini (nano-banana) / grok, per keys present
  if (Object.keys(imageEditors).length) console.log('image editing enabled:', Object.keys(imageEditors).join(', '))
  // Owner-switchable default image editor (like the brain switch). Multi-image work always
  // forces gemini (grok can't fuse), so this takes effect for single-image edits + single-subject scenes.
  let activeEditor: EditorName = (process.env.GIZMO_IMAGE_MODEL as EditorName) in imageEditors ? (process.env.GIZMO_IMAGE_MODEL as EditorName) : 'gemini'
  const switchImageModel = (name: EditorName): string => {
    if (!imageEditors[name]) return `${name} image model isn't available (missing API key)`
    activeEditor = name
    return `image model now ${name}`
  }
  // Text→image generation: FLUX.2 klein (fal) when the key is present — higher quality than
  // Pollinations — else the free Pollinations fallback. Also self-heals if flux errors.
  const bflKey = process.env.BFL_API_KEY
  const genImage = capped(async (prompt: string): Promise<Buffer> => {
    if (bflKey) {
      try {
        return await fluxGenerateImage(prompt, bflKey)
      } catch (e) {
        console.error('flux generation failed, falling back to pollinations:', (e as Error).message)
      }
    }
    return fetchAiImage(prompt)
  })

  // Two brains (whichever API keys exist). `activeBrain` is a live pointer the owner
  // can flip from chat (switch_model tool); the respond handler falls back to the
  // other brain if the active one errors (e.g. a quota 429).
  const MODELS: Record<BrainName, string> = {
    claude: process.env.GIZMO_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    gemini: process.env.GIZMO_GEMINI_MODEL ?? 'gemini-3.5-flash',
    grok: process.env.GIZMO_GROK_MODEL ?? 'grok-4.5',
  }
  const brains: Partial<Record<BrainName, ReturnType<typeof makeBrain>>> = {}
  // The photos Claude Code may get: a person's saved faces, or history photos (same ACL as searchHistory).
  const personPhotos = (name: string) => {
    const p = people.resolve(name)
    return p ? { name: p.names[0]!, photos: people.photos(p.id) } : undefined
  }
  const searchPhotos = async (q: string, limit: number, chatScope: string | undefined) => mediaLibrary.images(await search(q, { chatScope, limit: limit * 3 }), limit)
  const ccGrants = makePeopleGrants({ list: () => people.list(), resolve: (n) => people.resolve(n) }) // faces the worker may pull
  // Set once the brains exist (below); the worker's questions are answered by Gizmo's own brain.
  let askGizmoBrain: ((chatJid: string, question: string) => Promise<string>) | undefined
  // Gizmo's Claude Code (worker container): one long-lived session Dan talks to through Gizmo.
  const ccLine = config.claudeCodeToken
    ? makeClaudeCodeLine({
        url: config.workerUrl,
        fetch: withWorkerKey(config.workerUrl, config.workerKey),
        statePath: join(dirname(config.memoryDir), 'claude-code.json'),
        defaultChat: `${feedOwner}@s.whatsapp.net`,
        askGizmo: (chatJid, q) => (askGizmoBrain ? askGizmoBrain(chatJid, q) : Promise.reject(new Error('brain not ready'))),
        fulfil: makeFulfil({
          mayUse: ccGrants.allowed,
          personPhotos: (name) => personPhotos(name),
          searchPhotos: (chatJid) => (q, limit) => searchPhotos(q, limit, chatJid), // the worker sees the asking chat's photos, never the full corpus
          editors: imageEditors,
          defaultEditor: () => activeEditor,
          generate: genImage,
        }),
        // WhatsApp echoes our own sends back as 'append', which the turn handler drops — record them here.
        record: (chatJid, text, key) => {
          const now = Math.floor(Date.now() / 1000)
          store.ingest({ id: `cc:${chatJid}:${now}:${key}`, chatJid, senderJid: 'claude-code', senderName: 'Claude Code', text, ts: now, fromMe: true, source: 'dedicated' })
        },
        sendText: (chatJid, text) => dedicated.send({ chatJid, text }),
        sendFile: (chatJid, file, name, as, mimetype) =>
          as === 'image' ? dedicated.sendImage(chatJid, file) : as === 'video' ? dedicated.sendVideo(chatJid, file) : dedicated.sendDocument(chatJid, file, name, mimetype),
      })
    : undefined
  let activeBrain: BrainName = BRAINS.find((b) => config.brainModel.startsWith(b)) ?? 'claude'
  const switchBrain = (name: BrainName): string => {
    if (!brains[name]) return `${name} isn't available (missing API key)`
    activeBrain = name
    return `now running on ${name} (${MODELS[name]})`
  }
  // The household = the owners' PRIVATE group (you + Alex + Gizmo). AUTHORITATIVE source is
  // GIZMO_HOUSEHOLD_GROUP (a jid or a name) — membership data is sender-derived and too
  // sparse to reliably tell a private 2-person group from a big group where only the two
  // owners have spoken. Fall back to the membership heuristic only when it's unset.
  const posts = makePostStager()
  const actions = makePostStager() // claude_code / schedule_task, confirmed by confirm_action
  // The groups Gizmo may target, with their names (for name → jid resolution). Only
  // family/allowed groups when configured — a stranger's group named "Familia" never matches.
  const targetGroups = () => trustedGroups(store.dedicatedGroups(), config)
  const named = (jid: string) => ({ jid, name: store.getChatName(jid) ?? jid, members: store.chatMembers(jid).length })
  const namedGroups = () => targetGroups().map(named)
  const householdGroup = (): string | undefined => {
    const groups = targetGroups()
    if (config.householdGroup) {
      if (groups.includes(config.householdGroup)) return config.householdGroup // exact jid
      const byName = resolveGroup(config.householdGroup, namedGroups())
      if (byName) return byName
    }
    return pickHouseholdGroup(groups, (jid) => store.chatMembers(jid), config.owners, config.familyGroups)
  }

  const baseDeps: Omit<BrainDeps, 'model'> = {
    memory,
    search,
    recent: (limit, opts) => store.recentMessages(limit, opts),
    oldest: (limit, opts) => store.oldestMessages(limit, opts),
    range: (fromTs, toTs, limit, opts) => store.messagesInRange(fromTs, toTs, limit, opts),
    pageChat: (chatJid, offset, limit) => store.messagesByChatPaged(chatJid, offset, limit),
    setReminder: (r) => store.addReminder(r),
    listReminders: (chatJid) => store.remindersInChat(chatJid),
    cancelReminder: (id, chatJid, ownerId) => store.cancelReminder(id, chatJid, ownerId),
    getChatTz: (jid) => store.getChatTz(jid),
    setChatTz: (jid, tz) => store.setChatTz(jid, tz),
    sendText: (chatJid, text) => dedicated.send({ chatJid, text }),
    sendMeme: async (chatJid, template, top, bottom) => dedicated.sendImage(chatJid, await fetchMeme(template, top, bottom)),
    sendGif: async (chatJid, query) => dedicated.sendGif(chatJid, await fetchGif(query)),
    // Native WhatsApp primitives (poll/reaction/location/contact/quote/edit/delete).
    sendPoll: (chatJid, question, options) => dedicated.sendPoll(chatJid, question, options),
    react: (chatJid, emoji) => dedicated.react(chatJid, emoji),
    sendLocation: (chatJid, lat, lng, name) => dedicated.sendLocation(chatJid, lat, lng, name),
    geocode: (query) => geocode(query),
    sendContact: (chatJid, name, phone) => dedicated.sendContact(chatJid, name, phone),
    sendDocument: (chatJid, file, fileName, mimetype, caption) => dedicated.sendDocument(chatJid, file, fileName, mimetype, caption),
    files,
    ledger,
    fxToIls,
    replyQuote: (chatJid, text) => dedicated.replyQuote(chatJid, text),
    editLastMessage: (chatJid, text) => dedicated.editLast(chatJid, text),
    deleteLastMessage: (chatJid) => dedicated.deleteLast(chatJid),
    generateImage: guestCapped(async (chatJid: string, prompt: string) => dedicated.sendImage(chatJid, await genImage(prompt))),
    // Find a photo Gizmo has already seen (any chat, either socket) by description → re-send its real bytes.
    // Resolve the EXACT photo the owner means: the source chat's most recent stashed photo
    // (a reply's quoted image, or one just sent — the pre-stash/media pass put it there) is
    // deterministic for the owner's gesture; else fall back to history-by-description.
    resolvePhoto: async (query, sourceChatJid, chatScope) => {
      if (sourceChatJid) {
        const stashed = lastImageByChat.get(sourceChatJid).at(-1)
        if (stashed) return stashed // reply / just-sent: exact bytes, no guessing
      }
      return mediaLibrary.firstImage(await search(query, { chatScope })) // same ACL as searchHistory
    },
    sendPhotoBytes: (chatJid, image) => dedicated.sendImage(chatJid, image),
    // In-chat re-send: resolve the referenced photo and send it in THIS chat. THROWS on
    // not-found so the tool can report honestly (resend_photo catches it).
    sendSavedPhoto: async (chatJid, query, chatScope) => {
      const buf = await baseDeps.resolvePhoto!(query, chatJid, chatScope)
      if (!buf) throw new Error("couldn't find that photo in what I've seen — reply to the photo you mean, or resend it here")
      await dedicated.sendImage(chatJid, buf)
      return 'sent it 📸'
    },
    // Image + face-library tools (editImage, enrollPerson, composeScene, placeIntoPhoto,
    // forget/addNames/setRelation, listPeople) — extracted to a testable factory.
    listGroupPeople: (chatJid) => peopleFor(chatJid).list(),
    ...guestCapImageTools(makePeopleImageTools({
      people,
      peopleFor,
      imageEditors,
      lastImageByChat,
      sendImage: (chatJid, image, caption) => dedicated.sendImage(chatJid, image, caption),
      findJidByName: (name) => store.findJidByName(name),
      imageModel: () => activeEditor,
      // Face-lock inpaint: needs BOTH the BFL key (Fill) and the gemini key (face detection).
      keepFace:
        bflKey && process.env.GOOGLE_GENERATIVE_AI_API_KEY
          ? capped(async (image: Buffer, instruction: string) => {
              const box = await detectFaceBox(image)
              if (!box) throw new Error('no clear face found to lock')
              const mask = await buildKeepFaceMask(image, box)
              return fluxFillImage(image, mask, instruction, bflKey)
            })
          : undefined,
    })),
    switchImageModel, // owner-only tool flips the default image editor (gemini/grok)
    setAvatar: async ({ chatJid, description }) => {
      // Generate from a description, else reuse the most recent photo the owner sent.
      const img = description?.trim() ? await genImage(description) : lastImageByChat.get(chatJid).at(-1)
      if (!img) return 'no image — send me a photo first, or tell me what to draw'
      await dedicated.setAvatar(img)
      return description?.trim() ? 'done — generated a fresh look 😎' : 'done — using the photo you sent 😎'
    },
    webSearch: webSearch ?? undefined, // live web (Tavily) — works on any brain
    webFetch, // read full pages (Jina Reader, browser-rendered)
    sendWebMedia: (chatJid, url, caption) => makeSendWebMedia(dedicated)(chatJid, url, caption), // web photo/file → the real image/document; lazy: dedicated is declared later
    switchBrain, // owner-only tool flips the active model
    householdGroup,
    // Resolve a group by name → jid among the groups GIZMO is in. No name (or no match)
    // = the household group (the private owners' group).
    findGroup: (name) => (name?.trim() ? resolveGroup(name, namedGroups()) : householdGroup()),
    chatName: (jid) => groupLabel(named(jid)), // confirm read-back: name + jid tail + member count
    // Staged cross-chat send: held until the owner approves (see makePostStager).
    stagePost: posts.stage,
    confirmPost: posts.confirm,
    cancelPost: posts.cancel,
    actions,
    // Speak `text` as a voice note into any chat — same TTS pipeline as a spoken reply.
    sendVoiceNote: tts
      ? async (chatJid, text) => {
          const { ogg, seconds } = await toVoiceNote(await synthesize(text, tts))
          await dedicated.sendVoice(chatJid, ogg, seconds)
        }
      : undefined,
    // Self-coding (owner's DM only) → the coder sandbox service opens a PR. Off without the GitHub App.
    sandboxes: config.claudeCodeToken || config.githubAppId ? { owner: feedOwner, ...sandboxes } : undefined,
    claudeCode: ccLine
      ? {
          owner: feedOwner,
          send: async (chatJid, message, { photos: queries = [], chatScope, fresh } = {}) => {
            if (sandboxes.paused()) return PAUSED
            if (fresh && !(await ccLine.reset())) return "couldn't start a fresh conversation with Claude Code"
            if (fresh) ccGrants.clear()
            ccGrants.grant([message, ...queries])
            const recent = lastImageByChat.get(chatJid).map((buf, i) => ({ name: `just-sent-${i + 1}.jpg`, buf }))
            const { photos, missed } = await findPhotos(queries, { personPhotos, searchPhotos: (q, limit) => searchPhotos(q, limit, chatScope) })
            const sent = await ccLine.send(chatJid, message, [...recent, ...photos].slice(0, MAX_PHOTOS))
            return missed.length ? `${sent} No photos found for: ${missed.join(', ')}` : sent
          },
          status: () => ccLine.status(),
        }
      : undefined,
    proposeChange: config.githubAppId
      ? {
          owner: feedOwner,
          start: (() => {
            const start = makeCoderClient({ url: config.coderUrl, fetch: coderFetch, send: (chatJid, text) => dedicated.send({ chatJid, text }) })
            return async (chatJid: string, request: string) => (sandboxes.paused() ? PAUSED : start(chatJid, request))
          })(),
        }
      : undefined,
    soul: loadSoul(),
    maxSteps: 6,
    // Google ONLY for the single Google-owner (you), never in a group.
    extraTools: ({ id, inGroup, fromSandbox }) => ({ ...(googleTools && id === googleOwner && !inGroup && !fromSandbox ? googleTools : {}) }),
  }
  if (process.env.ANTHROPIC_API_KEY) brains.claude = makeBrain({ ...baseDeps, model: anthropic(MODELS.claude) })
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) brains.gemini = makeBrain({ ...baseDeps, model: google(MODELS.gemini) })
  if (process.env.XAI_API_KEY) brains.grok = makeBrain({ ...baseDeps, model: xai(MODELS.grok) })
  if (!brains[activeBrain]) activeBrain = (Object.keys(brains) as BrainName[])[0] // default to whatever exists
  // Claude on the owner's subscription (Claude Code); runs ahead of the API brain when claude is active.
  const subscription = config.claudeCodeToken
    ? makeClaudeCodeBrain(baseDeps, { token: config.claudeCodeToken, model: process.env.GIZMO_CC_MODEL })
    : undefined
  const hasBrain = Object.keys(brains).length > 0 || Boolean(subscription)
  console.log('brains:', Object.keys(brains).join(', ') || 'none (echo)', '| active:', activeBrain, '| subscription:', subscription ? 'on' : 'off')

  const dedicated = new BaileysTransport(config)

  const respond = makeResponder({
    transport: dedicated,
    brains,
    subscription,
    activeBrain: () => activeBrain, // getter — the owner can flip the model mid-session
    hasBrain,
    store,
    isOwner: (jid) => access.isOwner(jid),
    canonical: (jid) => access.canonical(jid),
    config,
    feedOwner,
    tts,
  })
  askGizmoBrain = respond.ask

  // Vision (understand images) when a Gemini key is present — supersedes OCR.
  const visionMedia: MediaDeps = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    ? { ...mediaDeps, describeImage: geminiVision }
    : mediaDeps
  // Capture group names (subjects) from both sockets so search can name the chat.
  const saveNames = (names: { jid: string; name: string }[]) => {
    for (const { jid, name } of names) store.upsertChatName(jid, name)
  }
  // Capture the address book / push-names so history-synced senders resolve to names
  // (97% of synced messages carry no push-name).
  const saveContacts = (contacts: { jid: string; name: string }[]) => {
    for (const { jid, name } of contacts) store.upsertContact(jid, name)
  }
  // Group membership → per-chat ACL. Resolve each participant to a canonical id
  // (owners → phone, so requester phones match) before storing.
  const saveMembers = (chatJid: string, members: string[], mode: 'set' | 'add' | 'remove') => {
    const canon = members.map((j) => access.canonical(j))
    if (mode === 'set') store.setChatMembers(chatJid, canon)
    else if (mode === 'add') store.addChatMembers(chatJid, canon)
    else store.removeChatMembers(chatJid, canon)
  }
  dedicated.onGroupNames(saveNames)
  dedicated.onContacts(saveContacts)
  dedicated.onMembers(saveMembers)
  // Ingest runs per message (history/search); respond runs once per coalesced turn.
  dedicated.onMessage(makeIngestHandler(store, 'dedicated', undefined, undefined, canonicalJid))
  dedicated.onTurn(respond)
  // Dedicated also stashes sent images so set_avatar can reuse "the photo you sent".
  // Paid media processing (download + vision/STT) only where Gizmo answers: an owner, or an
  // allowed group. A stranger's DM photo keeps its caption but costs nothing.
  dedicated.enableMedia({
    ...visionMedia,
    shouldProcess: ({ chatJid, senderJid, isGroup }) => access.isOwner(senderJid) || (Boolean(isGroup) && config.allowedGroups.includes(chatJid)),
    onImage: (chatJid, buf) => lastImageByChat.add(chatJid, buf),
    persistImage,
  })
  await dedicated.start()
  setTimeout(() => void ccLine?.run(), 10_000) // once WhatsApp is up: Claude Code's messages start flowing

  if (config.personalNumber) {
    const personal = new ReadOnlyBaileysTransport({
      personalNumber: config.personalNumber,
      credsDir: config.personalCredsDir,
    })
    personal.onGroupNames(saveNames)
    personal.onContacts(saveContacts)
    personal.onMembers(saveMembers)
    personal.onMessage(makeIngestHandler(store, 'personal', undefined, `${config.personalNumber}@s.whatsapp.net`, canonicalJid))
    // vision + persist bytes (so photos from other groups can be re-sent); no avatar-stash.
    // The owner's own feed: his groups and the DMs he has written in are processed (that's his
    // searchable history); a DM from someone he never answered is a stranger: caption only.
    personal.enableMedia({
      ...visionMedia,
      persistImage,
      shouldProcess: ({ chatJid, isGroup, fromMe }) => fromMe || Boolean(isGroup) || store.recentMessages(1, { fromMe: true, chatScope: chatJid }).length > 0,
    })
    // Liveness: silent personal-socket death = silent capture loss. Ping the owner.
    const alertJid = `${config.owners[0]}@s.whatsapp.net`
    personal.onDisconnect((reason) => {
      dedicated.send({ chatJid: alertJid, text: `⚠️ ${reason}` }).catch(() => {})
    })
    await personal.start()
    console.log('personal read-only sensor started')
  }

  const runBackfill = nonOverlapping(async () => {
    try {
      const n = await backfill(store, embedder)
      if (n) console.log(`indexed ${n} messages`)
    } catch (err) {
      console.error('backfill error:', (err as Error).message)
    }
  })
  await runBackfill()
  setInterval(runBackfill, BACKFILL_INTERVAL_MS)

  // Reminder scheduler — each reminder fires in its OWN stored chat (see fireDueReminders).
  const reminderTick = nonOverlapping(() =>
    fireDueReminders({ store, respond, send: (m) => dedicated.send(m), now: Math.floor(Date.now() / 1000) }),
  )
  setInterval(() => void reminderTick().catch((err) => console.error('reminder scheduler error:', (err as Error).message)), 30_000)

  // Dead-man's-switch: ping an external monitor every 5 min; if the box dies,
  // the monitor (e.g. Healthchecks.io) alerts the owner.
  if (config.healthcheckUrl) {
    const ping = () => fetch(config.healthcheckUrl!).catch(() => {})
    void ping()
    setInterval(ping, 5 * 60_000)
    console.log('healthcheck ping enabled')
  }

  console.log(
    `gizmo (phase 4: ${hasBrain ? `brain=${activeBrain}` : 'echo (no API key)'}) | owners=${config.owners.length} | db ${config.dbPath}`,
  )
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
