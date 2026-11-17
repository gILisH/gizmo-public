import { describe, it, expect } from 'vitest'
import { runSend } from '../src/cli'

describe('gizmo dev send', () => {
  it('runs a message through the pipeline and returns the reply', async () => {
    const replies = await runSend('111@s.whatsapp.net', 'hey there')
    expect(replies).toEqual(['hey there'])
  })
})
