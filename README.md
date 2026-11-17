# Gizmo

A self-hosted family WhatsApp assistant. Gizmo runs on its own WhatsApp number and answers the family in DMs and groups. It can also read the owner's own WhatsApp feed (read-only) so it can search and recall the family's history. Its personality lives in `SOUL.md`.

Developer guide: [`CLAUDE.md`](CLAUDE.md) — written for Claude Code, so pointing Claude Code at this repo is the fastest way to adapt it.

> **Before you run it:** Gizmo uses [Baileys](https://github.com/WhiskeySockets/Baileys), an *unofficial* WhatsApp client. WhatsApp can ban numbers that use it — run Gizmo on a spare number, never your main one. The optional personal socket reads your own WhatsApp feed (read-only); only turn it on if you're comfortable with your chat history living in Gizmo's database.

## What it can do

A capability is on only when its key is configured (see `CLAUDE.md` → Config).

- **Chat** in Hebrew or English, with a choice of brain: Claude, Gemini or Grok. The owner can switch brains from chat, and if one brain fails the next one takes over. Claude can also run on the owner's Claude subscription through Claude Code. A daily token budget caps spending.
- **Memory and history:** semantic + keyword search over every chat from both numbers, recent/oldest/date-range lookups, and per-person and family memory notes.
- **Media in:** describes photos (Gemini vision, or OCR without it), transcribes voice notes (Groq Whisper), and reads PDFs, Word, Excel and zip files. Messages sent as a burst (a photo with its caption, an album) get one reply.
- **Images:** generates images (FLUX, or free Pollinations without a key), edits photos (Gemini / Grok / FLUX), and uses a **face library** of known people (names, aliases, family relations, heights). With it Gizmo can put real family faces into new scenes or existing photos, keep a face pixel-locked, and re-send any photo it has seen.
- **WhatsApp native:** polls, reactions, locations (with geocoding), contacts, quoted replies, editing or deleting its own messages, memes and GIFs, voice-note replies (ElevenLabs), and setting its own profile picture.
- **Groups:** posts into another group only after the owner confirms. Guest (non-family) groups get no family context and keep their own face library.
- **Reminders and scheduled tasks** (one-off or hourly/daily/weekly), with a per-chat timezone for trips.
- **Web:** search (Tavily), reading full pages, and sending a photo or file from a URL.
- **Files:** creates csv/xlsx/pdf/txt files per chat, keeps them editable, and sends them as documents.
- **Pocket-money ledger** for the kids (`src/ledger`, `data/ledger.json`; owners only): purchases, income, transfers and adjustments with ILS conversion. Spending more than the balance needs the owner's confirmation. Entries are append-only, so fix mistakes with an adjustment.
- **Google** (owner's DM only): Gmail search/read, Calendar, Docs and Sheets.
- **Claude Code ("Gizmo's hands")**, owner only: one long-lived Claude Code session in a sandboxed `worker` container with internet access, for things Gizmo's own tools can't do (videos, scripts, documents). It runs long jobs as background agents, sends files back to the chat, can ask Gizmo questions, and can use Gizmo's image models and family photos without getting any API keys.
- **Self-coding**, owner only: describe a change and the `coder` service opens a pull request on this repo as a GitHub App. The PR is opened only after typecheck and tests pass on the box. It never deploys.
- **Off switch:** `stop_tasks` stops or pauses the worker and coder.

## Services (`docker-compose.yml`)

| Service | What it is |
|---|---|
| `gizmo` | The bot: both WhatsApp sockets, brains, tools, SQLite. Mounts `./data` (DB, creds, memory, media, ledger) and `SOUL.md`. No ports. |
| `search-ui` | Web UI for searching the history by hand (port 8899; bound to `GIZMO_UI_BIND`, default `127.0.0.1` — set it to your tailnet IP). Same image as `gizmo`. |
| `ollama` | Local embeddings (`bge-m3`) for semantic search. |
| `worker` | Claude Code agent (`Dockerfile.worker`). Gets only the Claude token; capped at 3 GB / 3 CPUs; state on named volumes. |
| `coder` | Self-coding sandbox (`Dockerfile.coder`). Gets only the Claude token + the GitHub App key (a compose secret). |

## Make it yours

1. **`SOUL.md`** — the personality and your household. Replace the `{{OWNER}}`, `{{PARTNER}}`, `{{KID_1}}`… placeholders and the household section. Text inside `<!-- family -->` is hidden from guest groups.
2. **`src/app.ts`** — the kids' names for the pocket-money ledger (search for `EDIT ME`). Drop the ledger if you don't need it.
3. **`.env`** — your numbers, owners, allowed groups and whichever API keys you have. Every key is optional except the dedicated number; a missing key just means that tool isn't there.
4. **`GIZMO_REPO`** — only if you use the self-coding `coder` service: your fork, e.g. `you/gizmo`.

## Setup

Requires Node 22 (`nvm use` reads `.nvmrc`).

```bash
nvm use
npm install
cp .env.example .env        # set GIZMO_DEDICATED_NUMBER (E.164 digits, no '+'), owners, and the keys you have
npm run dev                 # prints a pairing code on first run
```

On the dedicated phone, open WhatsApp → Linked Devices → Link with phone number, and enter the code. If `GIZMO_PERSONAL_NUMBER` is set, the personal socket prints its own code. With no brain key set, Gizmo just echoes messages back.

Never run two instances against the same number.

### Without WhatsApp

```bash
npm test
npm run typecheck
npm run cli -- dev send --from 111@s.whatsapp.net "hello world"
npm run cli -- search "birthday" --limit 5     # also: recent, oldest, google-auth, import-contacts
```

### Docker

```bash
docker compose up -d --build
docker compose exec ollama ollama pull bge-m3   # one-time
docker compose logs -f gizmo                    # pairing code on first run
```

Session creds persist in `./data`, so restarting doesn't require pairing again unless the session was logged out.

## Deploy

One small cloud box (Hetzner works well) reached over Tailscale; `deploy/provision.sh` sets it up and `deploy/README.md` walks through it. **Merging to `main` deploys:** a systemd timer on the box runs `deploy/autodeploy.sh` every 2 minutes. If `main` has moved, it fast-forwards and runs `docker compose up -d --build`, but waits while the worker or coder is busy. `deploy/push.sh` is the emergency path that skips git. Details are in `CLAUDE.md` → Deploy.

## License

MIT — see [`LICENSE`](LICENSE).
