import { createServer } from 'node:http'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { query, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { prTitle } from './title'
import { CLONE, PUBLISH, gitAuthEnv, installationToken, redact } from './github'
import { CODER_KEY_HEADER, keyMatches } from './auth'

// The self-coding sandbox: its own container, holding only a fresh repo clone, the GitHub
// App key and the Claude token — no .env, /data, WhatsApp or Google creds. Claude Code edits
// and tests; THIS code commits, pushes and opens the PR (as the app's bot). It never deploys.
const REPO = process.env.GIZMO_REPO ?? 'your-github-user/gizmo'
const APP_ID = process.env.GIZMO_APP_ID ?? ''
// Two uids. This server runs as root and alone holds the key + the git dir. Claude Code, yarn
// install and the test run (all of it code the agent wrote or chose) run as the image's `node`
// user, which can't read the key, the git dir, or this process's env/memory.
const AGENT = { uid: 1000, gid: 1000, home: '/home/node' }
const KEY_FILE = process.env.GIZMO_APP_KEY_FILE ?? '/run/secrets/github_app_key'
// Fail closed: the compose secret is a bind mount that keeps the host file's owner + mode.
const keyStat = statSync(KEY_FILE)
if (keyStat.mode & 0o077 || keyStat.uid === AGENT.uid) {
  throw new Error(`${KEY_FILE} is readable by the agent; on the box run: chown root:root secrets/github-app.pem && chmod 600 secrets/github-app.pem`)
}
const APP_KEY = readFileSync(KEY_FILE, 'utf8')
const SECRET = process.env.GIZMO_CODER_SECRET ?? '' // empty = every request is refused
const CC = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''
const MODEL = process.env.GIZMO_CODER_MODEL ?? 'opus'
const JOB_MS = 30 * 60_000

type Job = { state: 'running' } | { state: 'done'; url: string; title: string } | { state: 'failed'; reason: string }
const jobs = new Map<string, Job>()
let running: string | null = null // the request being worked on
let current: AbortController | null = null // the running job's, so POST /cancel can stop it

const sh = (cwd: string, cmd: string, args: string[], env?: Record<string, string>) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env && { ...process.env, ...env } }).trim()
// What the agent's processes see: no GitHub credential, no coder secret.
const agentEnv = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', HOME: AGENT.home, IS_SANDBOX: '1', ...extra })
const asAgent = (cwd: string, cmd: string, args: string[], extra: Record<string, string> = {}, timeout?: number) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], uid: AGENT.uid, gid: AGENT.gid, env: agentEnv(extra), timeout })
// Kill everything the agent uid left running, so nothing edits the tree after the checks pass.
const killAgentProcs = () => spawnSync(process.execPath, ['-e', 'process.kill(-1, "SIGKILL")'], { uid: AGENT.uid, gid: AGENT.gid })

const BRIEF = `You are improving Gizmo, the family WhatsApp agent in this repo, at its owner's request.
Read CLAUDE.md first and follow it. Make the change, add or update tests, then run
\`npm run typecheck\` and \`npm test\` until both pass. Do NOT commit, push or touch git.
Your FINAL message is the pull request: line 1 = a short title, then what changed, why,
and the test results. Write it in English.`

const FIX_ROUNDS = 2

// One Claude Code run in the clone. Resolves to its final message (the PR text) or why it failed.
async function agent(dir: string, prompt: string, abort: AbortController): Promise<{ ok: true; summary: string } | { ok: false; reason: string }> {
  try {
    for await (const m of query({
      prompt,
      options: {
        cwd: dir,
        model: MODEL,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: BRIEF },
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        disallowedTools: ['WebFetch', 'WebSearch'], // no outside content in the loop = no injected instructions
        maxTurns: 100,
        abortController: abort,
        // No GitHub credential: only this server pushes.
        env: agentEnv({ CLAUDE_CODE_OAUTH_TOKEN: CC }),
        // As the agent uid, not root: the key file is root-only. stderr → container logs.
        spawnClaudeCodeProcess: (o) =>
          spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, uid: AGENT.uid, gid: AGENT.gid, stdio: ['pipe', 'pipe', 'inherit'] }) as SpawnedProcess,
      },
    })) {
      if (m.type === 'result') {
        if (m.is_error || m.subtype !== 'success') return { ok: false, reason: `${m.subtype}${'result' in m ? `: ${m.result}` : ''}` }
        return { ok: true, summary: m.result }
      }
    }
  } catch (e) {
    if (abort.signal.aborted) return { ok: false, reason: 'aborted' } // the SDK throws on abort; the caller reads why
    throw e
  }
  return { ok: false, reason: 'agent ended without a result' }
}

// The gate: this server — not the agent's word — runs both checks on the box. Returns the
// vitest summary lines on success, or the failing output (tail) for the agent to fix.
function checks(dir: string): { ok: boolean; out: string } {
  let tests = ''
  for (const script of ['typecheck', 'test']) {
    try {
      const out = asAgent(dir, 'npm', ['run', script], { NO_COLOR: '1', FORCE_COLOR: '0' }, 10 * 60_000) // agent-written code: agent uid; plain text for the PR body
      if (script === 'test') tests = out.split('\n').filter((l) => /Test Files|Tests /.test(l)).map((l) => l.trim()).join('\n')
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string }
      return { ok: false, out: `\`npm run ${script}\` failed:\n${`${x.stdout ?? ''}\n${x.stderr ?? ''}`.slice(-3000)}` }
    }
  }
  return { ok: true, out: tests }
}

async function run(request: string): Promise<Job> {
  const dir = mkdtempSync(join(tmpdir(), 'job-')) // the work tree — handed to the agent
  const gitRoot = mkdtempSync(join(tmpdir(), 'git-')) // root-only (0700): hooks/config the agent can't plant
  const gitDir = join(gitRoot, 'repo') // clone --separate-git-dir wants it not to exist yet
  // Every git call names the git dir explicitly, so nothing in the agent-owned tree (a fake .git) is read.
  const git = (args: string[], env?: Record<string, string>) => sh(gitRoot, 'git', ['--git-dir', gitDir, '--work-tree', dir, ...args], env)
  try {
    const readTok = await installationToken(APP_ID, APP_KEY, REPO, CLONE) // 1h, gizmo only; never in the agent's env
    sh(tmpdir(), 'git', ['clone', '--depth', '50', '--separate-git-dir', gitDir, `https://github.com/${REPO}.git`, dir], gitAuthEnv(readTok))
    rmSync(join(dir, '.git')) // the gitfile pointing at gitDir; the agent has no git
    sh(tmpdir(), 'chown', ['-R', `${AGENT.uid}:${AGENT.gid}`, dir])
    asAgent(dir, 'yarn', ['install', '--frozen-lockfile', '--silent']) // runs package install scripts: agent uid
    const abort = current!
    if (abort.signal.aborted) return { state: 'failed', reason: 'stopped' }
    const timer = setTimeout(() => abort.abort('timeout'), JOB_MS)
    let summary = ''
    let verified = ''
    try {
      const first = await agent(dir, `The owner asked:\n\n${request}`, abort)
      if (abort.signal.aborted) return { state: 'failed', reason: abort.signal.reason === 'timeout' ? 'took longer than 30 minutes' : 'stopped' }
      if (!first.ok) return { state: 'failed', reason: first.reason }
      summary = first.summary
      // No PR unless typecheck + tests pass HERE; failures go back to the agent, a bounded number of times.
      for (let round = 0; ; round++) {
        killAgentProcs() // the tree is frozen from here to the commit
        if (!git(['status', '--porcelain'])) return { state: 'failed', reason: `no code changed. ${summary.slice(0, 500)}` }
        const c = checks(dir)
        if (c.ok) { verified = c.out; break }
        if (round === FIX_ROUNDS) return { state: 'failed', reason: `still failing after ${FIX_ROUNDS} fix rounds, so no PR was opened.\n${c.out.slice(-800)}` }
        const fix = await agent(dir, `Your change does not pass on the box. Fix it so typecheck and tests both pass, keep the original goal, and end with the full PR message again.\n\nOriginal request:\n${request}\n\n${c.out}`, abort)
        if (abort.signal.aborted) return { state: 'failed', reason: abort.signal.reason === 'timeout' ? 'took longer than 30 minutes' : 'stopped' }
        if (!fix.ok) return { state: 'failed', reason: fix.reason }
        summary = fix.summary
      }
    } finally {
      clearTimeout(timer)
    }
    killAgentProcs() // test code ran as the agent too
    const title = prTitle(summary)
    const branch = `gizmo/${Date.now()}`
    git(['checkout', '-b', branch])
    git(['add', '-A'])
    git(['-c', 'user.name=Gizmo', '-c', 'user.email=gizmo@users.noreply.github.com', 'commit', '--no-verify', '-m', title, '-m', `Requested on WhatsApp: ${request}`])
    const gh = await installationToken(APP_ID, APP_KEY, REPO, PUBLISH) // write only now, after the agent is done
    git(['push', 'origin', `HEAD:refs/heads/${branch}`], gitAuthEnv(gh))
    const res = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gh}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ title, head: branch, base: 'main', body: `> ${request}\n\n${summary}\n\n### ✅ Verified on the box before this PR was opened\n\`npm run typecheck\` clean.\n\`\`\`\n${verified}\n\`\`\`\n\n🤖 Written by Gizmo (Claude Code) — review before deploying.` }),
    })
    const pr = (await res.json()) as { html_url?: string; message?: string }
    if (!pr.html_url) return { state: 'failed', reason: `pushed ${branch} but PR failed: ${pr.message}` }
    return { state: 'done', url: pr.html_url, title }
  } catch (e) {
    return { state: 'failed', reason: (e as Error).message.slice(0, 500) }
  } finally {
    killAgentProcs()
    rmSync(dir, { recursive: true, force: true })
    rmSync(gitRoot, { recursive: true, force: true })
  }
}

// POST /jobs {request} → 202 {id} (409 + the running request if busy); GET /jobs/:id → Job;
// GET /status → {busy} (autodeploy waits on it so a rebuild never kills a job).
// ponytail: one job at a time, state in memory — a coder restart forgets running jobs (the PR, if pushed, survives).
createServer(async (req, res) => {
  const reply = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  // Every route, /status included (autodeploy sends it too). The agent shares this container's localhost.
  if (!keyMatches(req.headers[CODER_KEY_HEADER], SECRET)) return reply(401, { error: 'unauthorized' })
  if (req.method === 'POST' && req.url === '/jobs') {
    if (running) return reply(409, { error: 'busy', request: running })
    let raw = ''
    for await (const c of req) raw += c
    const request = String((JSON.parse(raw || '{}') as { request?: string }).request ?? '').trim()
    if (!request) return reply(400, { error: 'request required' })
    const id = randomUUID()
    running = request
    current = new AbortController()
    jobs.set(id, { state: 'running' })
    // redact: nothing token-shaped reaches WhatsApp, the DB or the logs.
    void run(request).then((j) => jobs.set(id, j.state === 'failed' ? { ...j, reason: redact(j.reason) } : j)).finally(() => { running = null; current = null })
    return reply(202, { id })
  }
  if (req.method === 'GET' && req.url === '/status') return reply(200, { busy: Boolean(running) })
  if (req.method === 'POST' && req.url === '/cancel') {
    current?.abort('stopped')
    return reply(200, { stopped: running })
  }
  const m = req.method === 'GET' && req.url?.match(/^\/jobs\/([\w-]+)$/)
  if (m) return reply(jobs.has(m[1]) ? 200 : 404, jobs.get(m[1]) ?? { error: 'unknown job' })
  reply(404, { error: 'not found' })
}).listen(Number(process.env.PORT ?? 8787), () => console.log(`coder listening (repo ${REPO}, model ${MODEL})`))
