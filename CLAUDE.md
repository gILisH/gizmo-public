# CLAUDE.md — Gizmo

Guidance for Claude Code working in this repo. Read it before editing.

## What Gizmo is

A self-hosted **family WhatsApp AI agent**. It connects to WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys) over **two sockets**, both built on `SocketBase` (`src/transport/socket.ts`: listeners, contact/group reporting, connect → pair → reconnect-with-backoff; deliberately **no send path**):

- **dedicated** (`BaileysTransport`) — Gizmo's own number. The only one that **replies**.
- **personal** (`ReadOnlyBaileysTransport`) — the owner's number, **read-only**: ingests the owner's chat feed into history/search, never sends (no `send` method exists on it or its base).

An inbound message → coalesced into a turn → the **brain** (Vercel AI SDK `generateText` with tools, or Claude Code on the owner's subscription) → a reply. History + semantic search live in SQLite. Two sandboxed side services: **worker** (Gizmo's hands, a long-lived Claude Code session) and **coder** (self-coding PRs).

## Commands

Node **22** required (`.nvmrc` = 22.22.2). Older Node breaks vitest — `nvm use 22` first.

```bash
nvm use 22
npm test            # vitest run  (the guard — run before every commit)
npm run typecheck   # tsc --noEmit
npm run dev         # tsx src/app.ts  (runs the bot locally; needs .env + creds)
npm run cli         # tsx src/cli.ts  — dev send | search | recent | oldest | google-auth | import-contacts
```

Runtime is **tsx** (no build step). `tsx` is a runtime dependency, not just dev.

## Architecture (request flow)

```
messages.upsert
  → src/transport/turn.ts  createTurnHandler   ← the ONE debounce (both sockets; personal is ingest-only)
       ├─ ingest  (per message, immediate)     → src/ingest/handler.ts → store (history/search)
       └─ respond (per TURN, coalesced)         → src/respond.ts makeResponder (queued per chat)
                                                     → brain.respond (src/brain/index.ts | claude-code.ts)
                                                         → prepareTurn → buildTools (src/brain/tools/*)
```

- **`src/transport/turn.ts` — the turn coalescer.** A burst for the same `(chat, sender)` (photo + separate caption, album, "this is X" then a photo, rapid texts) collapses into ONE `respond()`. Debounce `GIZMO_TURN_DEBOUNCE_MS` (default 1500ms); a media message takes a synchronous *hold* until download+describe so a sibling text can't reply first. The personal socket uses the same coalescer **ingest-only**, so a captioned photo is stored once. **Do NOT reintroduce a separate text pass + media pass** — the old design caused "one action → N replies".
- **`src/respond.ts` — `makeResponder(deps)`** returns the turn handler plus **`.ask(chatJid, question)`** (Claude Code's questions, answered by the same brains/budget/fallback and returned, not sent). Phases: `admit` (fromMe/ACL/budget/echo) → `buildOpts` → `runWithFallback` → `deliver` (voice/text) → `recordReply`. **One reply at a time per chat**: a turn arriving mid-reply waits on that chat's tail promise. Deps are structural so it's unit-testable.
- **`src/brain/`**
  - `index.ts` — `makeBrain`, `buildSystem`, `buildConversation`, and **`prepareTurn`** (system + messages + tools for a turn) / **`turnReply`** (text, voice/react flags, mediaNote) — shared by both brains, so a new per-turn option goes in one place.
  - `claude-code.ts` — `makeClaudeCodeBrain`: the same turn run by the Agent SDK on `CLAUDE_CODE_OAUTH_TOKEN`; Gizmo's tools are re-exposed as an in-process MCP server; Claude Code's own tools are off.
  - `types.ts` — `BrainDeps` (the injected capability bag), `ToolCtx`, **`BRAINS`** (`claude`/`gemini`/`grok`).
  - `format.ts` — pure helpers (dates, WhatsApp markup, message formatting).
  - **`tools/`** — each domain is a factory `(deps, id, ctx) => ToolSet` that owns its own owner-gating: `history`, `scheduling`, `memory`, `web`, `images`, `people`, `chat`, `settings` (switch_model / switch_image_model), `groups` (staged post_to_group → confirm_send), `whatsapp` (poll/react/location/contact/quote/edit/delete), `files` (per-chat csv/xlsx/pdf/txt in `src/files`, sent as documents), `self` (claude_code, claude_code_status, propose_change, stop_tasks — owner only), `ledger` (kids' pocket money, `src/ledger`, `data/ledger.json`; owners only, over-budget gated in code). `outbound.ts` is the single "what can be sent to a chat" schema used by post_to_group. Google tools (`src/google/tools.ts`) arrive via `extraTools`, Google owner's DM only.
- **`src/app.ts` — composition root.** Wires everything, builds the brains map, starts the sockets, backfill and reminder loops. `activeBrain` / `activeEditor` are `let`s (owner flips them at runtime) — pass **getters**, never snapshots.
- **`src/schedule.ts`** — `fireDueReminders` fires each due reminder in its **own stored chat** (claimed before running; at-most-once); a scheduled *task* replays its instruction through `respond`. `nonOverlapping` wraps the reminder tick and the backfill so a slow run skips the next tick.
- **`src/search/`** — `backfill` embeds unindexed rows every 30s; it **pauses on `EmbedderUnavailable`** (Ollama down) instead of zero-filling, and retries next run.
- **`src/groups.ts`** — `makePostStager` (cross-chat sends held until the owner confirms), `resolveGroup`, `pickHouseholdGroup`.
- **`src/media/`** — `ingestOneMedia` (download → HEIC → vision/OCR/transcribe/doc-extract → inbound), `saved-photo.ts` **`makeMediaLibrary`** (every image seen, on disk under `data/media/` keyed by msg id; search hit → bytes), `photo-stash.ts` (recent photos per chat, TTL), `tools.ts` (`makePeopleImageTools`, face-library logic), `edit.ts` (**`EDITORS`** `gemini`/`grok`/`flux`; `MULTI_CAPABLE` = gemini, flux), `bfl.ts` (FLUX async client), `facemask.ts` (face-lock mask for FLUX.1 Fill), `providers.ts`.
- **`src/people/`** — face library: stable id + `names[]`, photos `<id>/<n>.jpg`, relation edges (**`REL_TYPES`**) with auto-inverse. Guest groups get their own library under `data/people-groups/<jid>/`.
- **`src/store/`** — SQLite (`better-sqlite3` + `sqlite-vec`). Row ids are **namespaced by source** (`dedicated:<id>` / `personal:<id>`) — both sockets see the same DM with opposite `fromMe`.
- **`src/worker/`** — Gizmo's hands. `server.ts` (worker container, port 8788): ONE long-lived Claude Code session (survives deploys via volumes) that hands long work to background agents; MCP tools `ask_gizmo`, `send_message`, `send_file`, `generate_image`, `get_photos`. `client.ts` (`makeClaudeCodeLine`, in gizmo): forwards the owner's messages, polls events → WhatsApp, answers questions via `respond.ask`. `fulfil.ts` runs `generate_image`/`get_photos` in gizmo, so API keys never enter the sandbox. `control.ts`: stop/pause switch for worker + coder (pause flag on `/data`).
- **`src/coder/`** — self-coding (port 8787): clones the repo with a GitHub App token, Claude Code edits, then **this server** runs `npm run typecheck` + `npm test` (failures go back to the agent, bounded), commits to `gizmo/<ts>`, opens a PR as the app. Never deploys.

## Recipes

- **Add a tool:** add it to the right `src/brain/tools/*.ts` module (or a new file + one spread line in `tools/index.ts`), add its dep to `BrainDeps` as an optional field (a tool is exposed only when its dep is present), wire the dep in `app.ts` `baseDeps`. Gate owner-only tools in the module from `ctx`, not in the prompt.
- **Add a brain:** add the name to `BRAINS` (`brain/types.ts`), its model id to `MODELS` in `app.ts` (env-overridable), and a `brains.<name> = makeBrain({ ...baseDeps, model })` line behind its API key. `switch_model`, `GIZMO_BRAIN_MODEL` prefix matching and fallback pick it up from `BRAINS`.
- **Add an image editor:** add to `EDITORS` (and `MULTI_CAPABLE` if it fuses), register it in `editorsFromEnv` behind its key.

## Concepts that bite

- **The recurring bug class is "one human action arrives as N WhatsApp messages → N brain runs."** If you see duplicate/contradictory replies, suspect turn batching, not the tool.
- **The DB is the oracle, not the logs.** Logs only fire on error. Vision descriptions are stored inline as `[image] <desc>` rows with `source` + `from_me` + `ts`; Gizmo's own replies are `senderJid='gizmo'`, Claude Code's lines `'claude-code'`.
- **Daily token budget** (`GIZMO_DAILY_TOKEN_BUDGET`, default 2M) gates BEFORE brain selection and counts ALL models — "switch to gemini" does NOT lift it (`admit` → `budget`). Not a provider error.
- **Brain order:** subscription (Claude Code) first when `claude` is active and `maySubscribe` (owner's DM or a group), then the active brain, then EVERY other brain on error/timeout (60s). An unfunded brain can't sink a turn while another is healthy.
- **`GIZMO_BRAIN_MODEL` only picks the active brain by prefix** (`gemini…`/`grok…`, else claude). Model ids come from `GIZMO_ANTHROPIC_MODEL` / `GIZMO_GEMINI_MODEL` / `GIZMO_GROK_MODEL` / `GIZMO_CC_MODEL`.
- **Semantic search needs Ollama** for embeddings; in Docker it's the `ollama` service. Without it backfill pauses until it's back.
- **Code holds deterministic facts; the LLM does fuzzy reasoning.** Storage, ACL, gating, dedup → code. Don't move gating into prompts.

## Testing

Vitest, TDD expected. Inject deps/clocks so logic runs without network or real time (see `tests/transport/turn.test.ts` fake clock, `tests/respond.test.ts` fake transport/store/brains). Don't hit the network in tests. Keep the suite green before committing.

## Deploy

Runs on a single cloud box (Hetzner works well), reached over its tailnet IP, admin **only over Tailscale**. The Mac's Tailscale must be up ("connection timed out" + `tailscale status` stopped = local tailnet down).

**Deploy = merge to `main`.** `/root/gizmo` on the box is a git checkout of `main`. `deploy/gizmo-autodeploy.timer` runs `deploy/autodeploy.sh` every 2 minutes: flock (one at a time) → mint a 1h contents:read token from the GitHub App key (`GIZMO_APP_ID` in `.env` + `secrets/github-app.pem`) → fetch → if `origin/main` moved and **neither coder nor worker reports `busy` on `/status`** (else defer to the next tick) → `git merge --ff-only` → `docker compose up -d --build` (a failed build leaves running containers untouched). Logs: `journalctl -u gizmo-autodeploy`. `--ff-only` means a hand edit on the box blocks deploys until removed — never edit tracked files there.

Emergency only (bypasses `main`, box drifts from git): `bash deploy/push.sh` — rsyncs the tree (excluding `.env`, `data`, `secrets`, `.git`, `node_modules`) and rebuilds **only the `gizmo` service**. Doing it by hand: `--exclude .env --exclude secrets` is MANDATORY, and run rsync and a DETACHED build (`nohup docker compose up -d --build gizmo > /tmp/gizmo-build.log 2>&1 &`) as separate steps.

- **The box `.env` is the source of truth for runtime config** (local `.env` is stale). Edit it via ssh.
- **`docker compose restart` does NOT reload `.env` — use `up -d`.** Tell: key present, container fresh, capability absent.
- **Keep the 2 GB `/swapfile`**: the native `better-sqlite3` rebuild OOM-thrashed a swapless box.
- Verify: fresh container uptime, `docker logs gizmo-gizmo-1 | grep "socket connected"` (dedicated + personal), `grep brains:` shows the expected active brain/subscription, `docker exec … grep <new-symbol>` proves the new code is in the image.

## Config (.env)

All read in `src/config.ts` (`loadConfig` → `Config`) unless noted. Each key unlocks a capability; a missing key = the tool/brain simply isn't there.

- **Numbers / ACL:** `GIZMO_DEDICATED_NUMBER` (required), `GIZMO_PERSONAL_NUMBER`, `GIZMO_OWNERS`, `GIZMO_OWNER_NAMES` (`phone:Name,…`), `GIZMO_ALLOWLIST` (other family phones), `GIZMO_ALLOWED_GROUPS` (group jids Gizmo answers and processes media in; empty = none), `GIZMO_FAMILY_GROUPS` (any other group is a *guest* group: no owner tools, no family context), `GIZMO_HOUSEHOLD_GROUP` (jid or name of the owners' private group; authoritative — set it).
- **Brains:** `GIZMO_BRAIN_MODEL` (active brain by prefix), `ANTHROPIC_API_KEY` + `GIZMO_ANTHROPIC_MODEL`, `GOOGLE_GENERATIVE_AI_API_KEY` + `GIZMO_GEMINI_MODEL`, `XAI_API_KEY` + `GIZMO_GROK_MODEL`, `CLAUDE_CODE_OAUTH_TOKEN` (`claudeCodeToken`: subscription brain + worker + coder) + `GIZMO_CC_MODEL`.
- **Turn / history:** `GIZMO_DAILY_TOKEN_BUDGET`, `GIZMO_GUEST_DAILY_TOKEN_BUDGET` (200k per guest group per day, on top of the global budget), `GIZMO_TURN_DEBOUNCE_MS`, `GIZMO_HISTORY_LIMIT` (25), `GIZMO_HISTORY_WINDOW_HOURS` (48), `GIZMO_BURST_GAP_MIN` (120).
- **Images:** `GIZMO_IMAGE_MODEL` (default editor, owner-switchable), `GIZMO_GUEST_DAILY_IMAGES` (10 paid image actions per guest group per day, on top of the global 40), `GIZMO_GEMINI_IMAGE_MODEL`, `GIZMO_GROK_IMAGE_MODEL`, `BFL_API_KEY` (FLUX gen/edit + face-lock Fill, which also needs the Gemini key), `GIZMO_FLUX_MODEL` / `GIZMO_FLUX_EDIT_MODEL` / `GIZMO_FLUX_FILL_MODEL`, `GIZMO_BFL_BASE`, `GIZMO_GEMINI_VISION_MODEL` (face box). No BFL key → free Pollinations for generation.
- **Media in:** `GIZMO_VISION_MODEL` (Gemini vision; without the key → tesseract OCR), `GROQ_API_KEY` + `GIZMO_STT_MODEL` (voice transcription).
- **Other capabilities:** `TAVILY_API_KEY` (web_search), `JINA_API_KEY` (optional, web_fetch), `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL` (voice notes), `GIPHY_API_KEY`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_TOKEN_PATH` + `GIZMO_GOOGLE_OWNER` (owner's Gmail/Calendar/Docs/Sheets; also the feed owner), `GIZMO_FX_RATES` (`USD=3.7,EUR=4.05`; else live rates), `GIZMO_HEALTHCHECK_URL` (5-min dead-man's ping), `GIZMO_PDF_FONT`.
- **Sandboxes:** `GIZMO_APP_ID` (`githubAppId`: coder + autodeploy; key is box-only `secrets/github-app.pem`), `GIZMO_WORKER_URL` / `GIZMO_CODER_URL` (`workerUrl`/`coderUrl`, default compose DNS). `GIZMO_CODER_SECRET` (`coderSecret`): shared key for the coder's HTTP API, in the box `.env` (gizmo) + passed to coder by compose; unset = the coder refuses everything. Inside the containers: `GIZMO_WORKER_MODEL`, `GIZMO_CODER_MODEL` (default `opus`), `GIZMO_REPO`, `GIZMO_APP_KEY_FILE`. The worker gets only the Claude token; the coder only the token, its API key + app key (the key file must be root-only `chmod 600`: the coder's agent runs as uid 1000 and the server refuses to start otherwise).
- **Internal auth (fail closed — unset means refused):** `GIZMO_WORKER_KEY` (shared secret on every gizmo → worker API call; compose passes the same `.env` value to both), `GIZMO_SEARCH_UI_KEY` (search-ui; open `http://<tailnet-ip>:8899/?key=<it>` once, a cookie carries it after). Network split: worker and coder each share a compose network with gizmo only; search-ui + ollama sit on the default network.
- **Paths / infra:** `GIZMO_DB_PATH`, `GIZMO_MEMORY_DIR` (its parent dir holds people/, files/, ledger.json; `media/` sits next to the DB), `GIZMO_CREDS_DIR`, `GIZMO_PERSONAL_CREDS_DIR`, `GIZMO_OLLAMA_URL`, `GIZMO_EMBED_MODEL` (`bge-m3`), `GIZMO_LOG_LEVEL`, `GIZMO_UI_PORT` (search-ui).

## Further reading

`README.md` (overview), `SOUL.md` (personality prompt).

## Safety

Never paste secrets into chat/transcripts. WhatsApp connects one session per number — never run a second instance against the same number. Don't commit `.env`.
