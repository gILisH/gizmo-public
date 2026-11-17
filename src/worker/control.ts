import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// The off switch for Gizmo's sandboxes (worker + coder). stop() aborts whatever is running;
// pause leaves a flag file on Gizmo's /data, so new tasks are refused until resume — it
// survives deploys (autodeploy restarts every container) and the sandboxes can't touch it.
export function makeSandboxControl(o: { urls: Record<string, string>; flagPath: string; fetch?: typeof fetch }) {
  const f = o.fetch ?? fetch
  return {
    paused: () => existsSync(o.flagPath),
    // Returns what was stopped, e.g. ["worker: birthday video"]; a sandbox that's down is skipped.
    async stop(): Promise<string[]> {
      const out: string[] = []
      for (const [name, url] of Object.entries(o.urls)) {
        const r = await f(`${url}/cancel`, { method: 'POST' }).then((x) => x.json()).catch(() => null) as { stopped?: string | null } | null
        if (r?.stopped) out.push(`${name}: ${r.stopped}`)
      }
      return out
    },
    pause() {
      mkdirSync(dirname(o.flagPath), { recursive: true })
      writeFileSync(o.flagPath, new Date().toISOString())
    },
    resume() {
      rmSync(o.flagPath, { force: true })
    },
  }
}
export type SandboxControl = ReturnType<typeof makeSandboxControl>
