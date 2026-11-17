// The always-on Claude Code session's plumbing, apart from the SDK: Dan's messages queue in
// as a stream (the SDK folds one that arrives mid-turn into the running turn), everything it
// says comes out as numbered events Gizmo polls and posts to WhatsApp, and its questions for
// Gizmo's brain wait here for an answer. Status is facts from the SDK stream, not a guess.
export type Event =
  | { seq: number; kind: 'text'; text: string }
  | { seq: number; kind: 'error'; text: string }
  | { seq: number; kind: 'file'; path: string; caption?: string }
  | { seq: number; kind: 'question'; id: number; text: string }
  | { seq: number; kind: 'request'; id: number; tool: GizmoTool; args: Record<string, unknown> }
export type GizmoTool = 'generate_image' | 'get_photos'
// What Gizmo hands back for a request: files (base64) and/or a note.
export type Fulfilment = { text?: string; files?: Array<{ name: string; data: string }> }
type NewEvent = Event extends infer E ? (E extends Event ? Omit<E, 'seq'> : never) : never
export type Task = { id: string; description: string; name?: string }
// How Gizmo marks a message for one running task; the worker's brief quotes the same tag.
export const taskTag = (name: string) => `[re: ${name}]`
export type Status = { busy: boolean; turnSince: number | null; activity: Array<{ at: number; text: string }>; tasks: Task[]; question: string | null }

const KEEP_EVENTS = 500
const KEEP_ACTIVITY = 8
export const QUIET = '(quiet)' // a turn with nothing worth telling him ends with exactly this

export function makeSession(now: () => number = Date.now) {
  const events: Event[] = []
  let seq = 0
  const queue: string[] = []
  let wake: (() => void) | null = null
  let gen = 0
  let turnSince: number | null = null
  const activity: Status['activity'] = []
  let tasks: Task[] = []
  // A background agent's name (what SendMessage addresses) comes from its Agent call; the task
  // list only has ids, so tool_use id → name, then task id → name once the task starts.
  // ponytail: never pruned — a few entries per agent for the process's life.
  const agentNames = new Map<string, string>()
  const taskNames = new Map<string, string>()
  const named = () => tasks.map((t) => (taskNames.has(t.id) ? { ...t, name: taskNames.get(t.id) } : t))
  const questions = new Map<number, { text: string; answer: (a: string) => void }>()
  const requests = new Map<number, (r: Fulfilment) => void>()
  let qid = 0

  const emit = (e: NewEvent) => {
    events.push({ ...e, seq: ++seq } as Event)
    if (events.length > KEEP_EVENTS) events.shift()
  }

  return {
    emit,
    // A turn's final reply: posted unless it's the quiet marker or empty.
    reply(text: string) {
      if (text.trim() && text.trim() !== QUIET) emit({ kind: 'text', text: text.trim() })
    },
    since(after: number) {
      return { events: events.filter((e) => e.seq > after), last: seq }
    },

    // Dan's messages → the SDK. One live stream at a time: endStream() retires the current
    // one (reset / restart) and anything still queued goes to the next.
    push(text: string) {
      queue.push(text)
      turnSince ??= now()
      wake?.()
    },
    async *stream(): AsyncGenerator<string> {
      const mine = ++gen
      while (mine === gen) {
        const next = queue.shift()
        if (next !== undefined) { yield next; continue }
        let mineWake!: () => void
        await new Promise<void>((r) => { mineWake = r; wake = r })
        if (wake === mineWake) wake = null // a newer stream may have taken over the wake-up
      }
    },
    endStream() {
      gen++
      wake?.()
    },

    // What the SDK stream says it's doing.
    working() { turnSince ??= now() },
    turnEnded() { turnSince = queue.length ? now() : null },
    note(text: string) {
      activity.push({ at: now(), text: text.slice(0, 160) })
      if (activity.length > KEEP_ACTIVITY) activity.shift()
    },
    setTasks(t: Task[]) { tasks = t },
    tasks: named,
    agentNamed(toolUseId: string, name: string) { agentNames.set(toolUseId, name) },
    taskStarted(taskId: string, toolUseId: string) {
      const n = agentNames.get(toolUseId)
      if (n) taskNames.set(taskId, n)
    },

    // Agent → Gizmo's brain: resolves with the answer, or a fallback after waitMs.
    ask(text: string, waitMs: number): Promise<string> {
      const id = ++qid
      emit({ kind: 'question', id, text })
      return new Promise((resolve) => {
        const t = setTimeout(() => { questions.delete(id); resolve("Gizmo didn't answer in time; make a sensible choice and say what you chose.") }, waitMs)
        questions.set(id, { text, answer: (a) => { clearTimeout(t); questions.delete(id); resolve(a) } })
      })
    },
    answer(id: number, text: string): boolean {
      const q = questions.get(id)
      q?.answer(text)
      return Boolean(q)
    },

    // Agent → Gizmo's own tools (its image generators, the family's photos): resolves with
    // what Gizmo hands back, or a note after waitMs. Shares the numbering with questions.
    request(tool: GizmoTool, args: Record<string, unknown>, waitMs: number): Promise<Fulfilment> {
      const id = ++qid
      emit({ kind: 'request', id, tool, args })
      return new Promise((resolve) => {
        const t = setTimeout(() => { requests.delete(id); resolve({ text: "Gizmo didn't deliver in time." }) }, waitMs)
        requests.set(id, (r) => { clearTimeout(t); requests.delete(id); resolve(r) })
      })
    },
    fulfil(id: number, r: Fulfilment): boolean {
      const done = requests.get(id)
      done?.(r)
      return Boolean(done)
    },

    status(): Status {
      const q = [...questions.values()].at(-1)
      return { busy: turnSince !== null || tasks.length > 0, turnSince, activity: [...activity], tasks: named(), question: q?.text ?? null }
    },
  }
}
export type Session = ReturnType<typeof makeSession>

// One line of activity from an SDK assistant message's content blocks.
export function describeStep(block: { type: string; name?: string; input?: any; text?: string }): string | null {
  if (block.type === 'tool_use') {
    const i = block.input ?? {}
    if (block.name === 'Bash') return `$ ${String(i.command ?? '').split('\n')[0]}`
    if (block.name === 'Agent' || block.name === 'Task') return `started a background agent: ${i.name ? `${i.name}: ` : ''}${i.description ?? ''}`
    const arg = i.file_path ?? i.path ?? i.url ?? i.query ?? i.pattern ?? i.text ?? i.question ?? ''
    return `${(block.name ?? 'tool').replace(/^mcp__gizmo__/, '')}${arg ? ` ${String(arg).split('\n')[0]}` : ''}`
  }
  if (block.type === 'text' && block.text?.trim()) return `“${block.text.trim().split('\n')[0]}”`
  return null
}
