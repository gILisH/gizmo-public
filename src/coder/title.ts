// PR title = the agent's first non-empty line, minus markdown decoration, capped for GitHub.
export function prTitle(summary: string): string {
  const line = summary.split('\n').map((l) => l.replace(/^[#*\s]+|[*\s]+$/g, '')).find(Boolean)
  return (line ?? 'Change requested by the owner').slice(0, 72)
}
