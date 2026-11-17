import { tmpdir } from 'node:os'
import { query, tool as mcpTool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { BrainDeps } from './types'
import { prepareTurn, turnReply, type RespondOpts } from './index'

// The same brain as makeBrain, but run by Claude Code (Agent SDK) on the owner's Claude
// subscription (CLAUDE_CODE_OAUTH_TOKEN) instead of per-token API billing. Same system
// prompt, conversation and tools — Gizmo's AI SDK tools are re-exposed as an in-process
// MCP server; Claude Code's own tools (Bash, Edit, …) are off.
export function makeClaudeCodeBrain(deps: Omit<BrainDeps, 'model'>, opts: { token: string; model?: string }) {
  const maxSteps = deps.maxSteps ?? 6
  // Minimal env: no ANTHROPIC_API_KEY (it would win over the token and bill per token),
  // and none of Gizmo's other secrets reach the subprocess.
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), CLAUDE_CODE_OAUTH_TOKEN: opts.token, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  return {
    async respond(id: string, userText: string, o: RespondOpts = {}) {
      const { system, messages: conv, tools } = prepareTurn(deps, id, userText, o)
      const server = createSdkMcpServer({
        name: 'gizmo',
        alwaysLoad: true, // don't hide tools behind tool search — that costs an extra step per turn
        tools: Object.entries(tools).map(([name, t]: [string, any]) =>
          mcpTool(name, t.description ?? name, t.inputSchema.shape, async (args) => {
            try {
              const r = await t.execute(args, { toolCallId: name, messages: [] })
              return { content: [{ type: 'text' as const, text: typeof r === 'string' ? r : JSON.stringify(r) }] }
            } catch (e) {
              return { content: [{ type: 'text' as const, text: `error: ${(e as Error).message}` }], isError: true }
            }
          }),
        ),
      })
      // ponytail: history goes in as one transcript prompt (Gizmo's DB is the memory); no Claude Code session resume.
      const prompt = conv.map((m) => `${m.role === 'user' ? '[them]' : '[you]'} ${m.content}`).join('\n\n')
      const calls: Array<{ toolName: string; input: unknown }> = []
      let text = ''
      for await (const m of query({
        prompt: `Conversation so far (reply to the last [now] message):\n\n${prompt}`,
        options: {
          model: opts.model ?? 'sonnet',
          systemPrompt: system,
          mcpServers: { gizmo: server },
          allowedTools: Object.keys(tools).map((n) => `mcp__gizmo__${n}`),
          tools: [],
          settingSources: [],
          permissionMode: 'dontAsk',
          persistSession: false,
          maxTurns: maxSteps,
          cwd: tmpdir(),
          env,
        },
      })) {
        if (m.type === 'assistant')
          for (const b of m.message.content) if (b.type === 'tool_use') calls.push({ toolName: b.name.replace(/^mcp__gizmo__/, ''), input: b.input })
        if (m.type === 'result') {
          if (m.is_error || m.subtype !== 'success') throw new Error(`claude-code: ${m.subtype}${'result' in m ? ` — ${m.result}` : ''}`)
          text = m.result
        }
      }
      // tokens: 0 — subscription turns don't spend the per-token daily budget.
      return turnReply(text, [{ toolCalls: calls }], 0)
    },
  }
}
