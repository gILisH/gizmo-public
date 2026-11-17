// One shared daily cap on paid image calls: every generate/edit/compose path (chat tools,
// post_to_group, set_avatar, the worker) goes through the wrapped engines, so no path is uncapped.
// ponytail: in-memory per-UTC-day count — a restart resets it; it stops a runaway loop or abuse, it isn't a budget.
export function makeDailyCap(limit: number, now: () => number = Date.now) {
  let day = ''
  let used = 0
  return <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const today = new Date(now()).toISOString().slice(0, 10)
      if (today !== day) { day = today; used = 0 }
      if (used >= limit) throw new Error(`the daily image limit (${limit}) is reached; it resets tomorrow`)
      used++
      return fn(...a)
    }
}

// A separate daily cap per chat for the chats `limited` picks (guest groups), on top of the
// global one. Wraps functions whose FIRST argument is the chat jid.
export function makeChatCap(limit: number, limited: (chatJid: string) => boolean, now: () => number = Date.now) {
  const caps = new Map<string, ReturnType<typeof makeDailyCap>>()
  return <A extends [string, ...unknown[]], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      if (!limited(a[0])) return fn(...a)
      if (!caps.has(a[0])) caps.set(a[0], makeDailyCap(limit, now))
      return caps.get(a[0])!(fn)(...a)
    }
}
