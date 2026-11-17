// Gizmo's side of self-coding: start a job on the coder sandbox, then poll it in the
// background and post the PR link (or why it failed) back to the chat that asked.
// ponytail: the poll lives in this process — a Gizmo restart mid-job loses the message, not the PR.
export function makeCoderClient(o: {
  url: string
  send: (chatJid: string, text: string) => Promise<void>
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  maxMs?: number
}) {
  const f = o.fetch ?? fetch
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = o.pollMs ?? 20_000
  const maxMs = o.maxMs ?? 40 * 60_000

  const poll = async (chatJid: string, id: string) => {
    for (let waited = 0; waited < maxMs; waited += pollMs) {
      await sleep(pollMs)
      const job = await f(`${o.url}/jobs/${id}`).then((r) => r.json()).catch(() => null) as
        | { state: 'running' } | { state: 'done'; url: string; title: string } | { state: 'failed'; reason: string } | null
      if (job?.state === 'done') return o.send(chatJid, `🛠️ PR מוכן: ${job.title}\n${job.url}`)
      if (job?.state === 'failed') return o.send(chatJid, job.reason === 'stopped' ? '🛑 השינוי בקוד נעצר' : `🛠️ לא הצלחתי לבצע את השינוי: ${job.reason}`)
    }
    return o.send(chatJid, '🛠️ השינוי לוקח יותר מדי זמן — כדאי לבדוק את ה-coder')
  }

  return async (chatJid: string, request: string): Promise<string> => {
    const res = await f(`${o.url}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) }).catch(() => null)
    if (!res) return 'could not reach the coding sandbox'
    if (res.status === 409) {
      const { request: current } = (await res.json().catch(() => ({}))) as { request?: string }
      return `busy: you are already writing this change: "${current ?? 'unknown'}". Its PR link comes first; this new one can start after it arrives.`
    }
    if (!res.ok) return `could not start the change (status ${res.status})`
    const { id } = (await res.json()) as { id: string }
    void poll(chatJid, id).catch((e) => console.error('coder poll failed:', (e as Error).message))
    return 'started: the change is being written now; the pull request link will be posted in this chat when ready (usually 5–20 minutes). Tell him he can say stop to cancel it.'
  }
}
