import { describe, it, expect } from 'vitest'
import { ReadOnlyBaileysTransport } from '../../src/transport/readonly'

describe('ReadOnlyBaileysTransport', () => {
  it('has no send method (structural read-only guarantee)', () => {
    const t = new ReadOnlyBaileysTransport({ personalNumber: '111', credsDir: '/tmp/x' })
    expect((t as any).send).toBeUndefined()
  })

  it('accepts a message handler and exposes start', () => {
    const t = new ReadOnlyBaileysTransport({ personalNumber: '111', credsDir: '/tmp/x' })
    expect(typeof t.onMessage).toBe('function')
    expect(typeof t.start).toBe('function')
  })
})
