import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './store/types'
import { mediaFileName, msgIdOf } from './media/saved-photo'

// Remove status (story) + channel rows, their index entries and saved photo files.
export function purgeStatuses(store: Pick<Store, 'deleteChats'>, mediaDir: string): { rows: number; files: number } {
  const ids = [...store.deleteChats('status@broadcast'), ...store.deleteChats('%@newsletter')]
  let files = 0
  for (const id of ids) {
    const f = join(mediaDir, mediaFileName(msgIdOf(id)))
    if (existsSync(f)) { rmSync(f); files++ }
  }
  return { rows: ids.length, files }
}
