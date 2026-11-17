// The worker's HTTP API is guarded by a shared secret (GIZMO_WORKER_KEY, set for gizmo + worker).
export const WORKER_KEY_HEADER = 'x-gizmo-worker-key'

// A fetch that adds the key to requests for the worker only — never leaks it to other services.
export function withWorkerKey(workerUrl: string, key: string | undefined, f: typeof fetch = fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (!key || !String(input instanceof Request ? input.url : input).startsWith(workerUrl)) return f(input, init)
    const headers = new Headers(init?.headers)
    headers.set(WORKER_KEY_HEADER, key)
    return f(input, { ...init, headers })
  }) as typeof fetch
}
