import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  it('reads the dedicated number and defaults the creds dir', () => {
    const c = loadConfig({ GIZMO_DEDICATED_NUMBER: '972500000000' } as NodeJS.ProcessEnv)
    expect(c.dedicatedNumber).toBe('972500000000')
    expect(c.credsDir).toBe('data/creds/dedicated')
    expect(c.dbPath).toBe('data/gizmo.db')
  })

  it('honors an explicit creds dir', () => {
    const c = loadConfig({
      GIZMO_DEDICATED_NUMBER: '972500000000',
      GIZMO_CREDS_DIR: '/tmp/creds',
    } as NodeJS.ProcessEnv)
    expect(c.credsDir).toBe('/tmp/creds')
  })

  it('throws when the dedicated number is missing', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/GIZMO_DEDICATED_NUMBER/)
  })

  it('personal number is optional; personal creds dir defaults', () => {
    const c = loadConfig({ GIZMO_DEDICATED_NUMBER: '972500000000' } as NodeJS.ProcessEnv)
    expect(c.personalNumber).toBeUndefined()
    expect(c.personalCredsDir).toBe('data/creds/personal')
    const c2 = loadConfig({
      GIZMO_DEDICATED_NUMBER: '972500000000',
      GIZMO_PERSONAL_NUMBER: '972501111111',
    } as NodeJS.ProcessEnv)
    expect(c2.personalNumber).toBe('972501111111')
  })

  it('parses owners/allowlist CSV and defaults the brain model', () => {
    const c = loadConfig({
      GIZMO_DEDICATED_NUMBER: '972500000000',
      GIZMO_OWNERS: '972500000000, 972501111111',
      GIZMO_ALLOWLIST: '972502222222',
    } as NodeJS.ProcessEnv)
    expect(c.owners).toEqual(['972500000000', '972501111111'])
    expect(c.allowlist).toEqual(['972502222222'])
    expect(c.brainModel).toBe('claude-sonnet-4-6')
    expect(c.dailyTokenBudget).toBe(2_000_000) // default budget
    expect(loadConfig({ GIZMO_DEDICATED_NUMBER: '1' } as NodeJS.ProcessEnv).owners).toEqual([])
  })
})
