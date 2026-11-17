import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { toolResult } from '../format'
import { taskTag } from '../../worker/session'

// Self-coding: only the code owner (Dan — matched by phone, NOT the owner flag, which
// includes Alex), only in his private DM. The change runs in a separate
// sandbox and comes back as a pull request — nothing goes live until he deploys it.
export function selfTools(deps: BrainDeps, id: string, ctx: ToolCtx): ToolSet {
  return { ...changeTools(deps, id, ctx), ...claudeCodeTools(deps, id, ctx), ...controlTools(deps, id, ctx) }
}

// The off switch: stop running tasks / code changes, optionally pause new ones. Dan only.
function controlTools(deps: BrainDeps, id: string, ctx: ToolCtx): ToolSet {
  const sb = deps.sandboxes
  if (!sb || id !== sb.owner || ctx.guest) return {}
  return {
    stop_tasks: tool({
      description:
        "Stop your background work: aborts everything Claude Code is doing (its current reply and every background job) and any code change (propose_change) right away. Use when he asks to cancel, stop, kill or halt them, or if something looks wrong. action 'stop' stops what's running; 'pause' also refuses messages to Claude Code and code changes until he says to turn them back on; 'resume' turns them back on.",
      inputSchema: z.object({ action: z.enum(['stop', 'pause', 'resume']) }),
      execute: async ({ action }) =>
        toolResult(async () => {
          if (action === 'resume') {
            sb.resume()
            return 'resumed: tasks and code changes can start again'
          }
          const stopped = await sb.stop()
          if (action === 'pause') sb.pause()
          const what = stopped.length ? `stopped ${stopped.join('; ')}` : 'nothing was running'
          return action === 'pause' ? `${what}. Paused: new tasks and code changes are refused until he says to resume.` : what
        }, "couldn't reach the sandboxes"),
    }),
  }
}

// Gizmo's Claude Code: one long-lived Claude Code session on the server (terminal, internet,
// installs anything) that Dan talks to through Gizmo any time. Dan only — it runs on his
// subscription. Groups are fine (its answers land where he asked); never in a guest group.
// A message to it is STAGED, not sent: it has a terminal and the internet, so text that
// steered this turn (a forwarded message, an email, a web page) must not reach it without
// Dan saying yes in a later turn (confirm_action). No stager wired → no tool (fail closed).
function claudeCodeTools(deps: BrainDeps, id: string, ctx: ToolCtx): ToolSet {
  const cc = deps.claudeCode
  const actions = deps.actions
  if (!cc || !actions || id !== cc.owner || ctx.guest) return {}
  return {
    claude_code: tool({
      description:
        "Talk to Claude Code: a full Claude Code agent on your server — terminal, internet, installs whatever it needs — that Dan can talk to any time, through you. It remembers the whole conversation across days, and runs long work in the background while staying free to talk. Use it whenever he talks to or about Claude Code (a question, an instruction, a change to something it's making, asking how it's going), and for anything your own tools can't do: make a video or animation, build a PDF / presentation / spreadsheet / chart, convert or process files, edit photos beyond your image tools, write and run code, crunch numbers, research across many pages. Pass his message in his own words and language, plus any context it can't know (who people are, what was said in the chat). Photos sent in this chat in the last minute go along automatically; for others, list them in photos — a person's name gets their saved face photos, a description finds matching photos from chat history. Claude Code answers in this chat itself (its messages start with 🛠️): don't answer for it, predict or repeat its reply — a few words from you at most. fresh: true only when he asks to start over with Claude Code (it forgets the conversation). Claude Code can run several named tasks at once and change one mid-work: when his message changes or asks about one running task, check claude_code_status for the task names and pass the matching one in task; if it could be more than one, ask him which. This STAGES the message: show him what you'll pass on and send it only after he says yes (confirm_action).",
      inputSchema: z.object({
        message: z.string().describe('his message, in his words and language, plus context it needs'),
        photos: z.array(z.string()).optional().describe('photos to pass: a person\'s name (e.g. "Eden") for their saved face photos, or a description to find in chat history (e.g. "the Thailand beach photos"). Up to 20 photos in all.'),
        fresh: z.boolean().optional().describe('start a new conversation first (only when he asks to start over)'),
        task: z.string().optional().describe('name of the running task this message is about, from claude_code_status (e.g. "tokyo-video"); leave out for a new request or a general message'),
      }),
      execute: async ({ message: text, photos, fresh, task }) => {
        const message = task?.trim() ? `${taskTag(task.trim())} ${text}` : text
        const chat = ctx.chatJid ?? id
        actions.stage(chat, 'message to Claude Code', () => toolResult(() => cc.send(chat, message, { photos, chatScope: ctx.chatScope, fresh }), "couldn't reach Claude Code"), ctx.turnId ?? '')
        const extra = [photos?.length ? `photos: ${photos.join(', ')}` : '', fresh ? 'starting a fresh conversation' : ''].filter(Boolean).join('; ')
        return `STAGED, not sent yet. Show Dan what will go to Claude Code ("${message}"${extra ? ` — ${extra}` : ''}) and ask him to approve. Only after he says yes call confirm_action; if no, cancel_action.`
      },
    }),
    claude_code_status: tool({
      description: "What Claude Code is doing right now, straight from the server: whether it's mid-reply, its running tasks by name and its latest steps. Use when he asks how it's going and you want facts fast, and to find which task a message is about; to ask Claude Code itself, use claude_code. Never guess.",
      inputSchema: z.object({}),
      execute: async () => toolResult(() => cc.status(), "couldn't check Claude Code"),
    }),
  }
}

function changeTools(deps: BrainDeps, id: string, ctx: ToolCtx): ToolSet {
  const pc = deps.proposeChange
  if (!pc || id !== pc.owner || ctx.inGroup || ctx.guest) return {}
  return {
    propose_change: tool({
      description:
        'Change your OWN code — you CAN improve yourself. Starts a sandboxed coding run on your source repo that writes the change, runs the tests and opens a pull request for the owner to review; nothing goes live until he deploys it. Use when he asks you to fix something in yourself, add a capability, or do something better (e.g. better image editing, a new tool, a behaviour fix). Pass a complete, specific description of the change in English, including any examples he gave. Then tell him it started and that the PR link will arrive in this chat.',
      inputSchema: z.object({ request: z.string().describe('the full change to make, in English, with examples') }),
      execute: async ({ request }) => toolResult(() => pc.start(ctx.chatJid ?? id, request), "couldn't start the change"),
    }),
  }
}
