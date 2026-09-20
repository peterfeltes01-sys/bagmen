import { describe, it, expect } from 'vitest'
import { createRng } from './rng.js'

describe('createRng', () => {
  it('produces deterministic output for the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    expect(a()).toBe(b())
    expect(a()).toBe(b())
    expect(a()).toBe(b())
  })

  it('produces different sequences for different seeds', () => {
    expect(createRng(1)()).not.toBe(createRng(2)())
  })

  it('returns values in [0, 1)', () => {
    const rng = createRng(99999)
    for (let i = 0; i < 200; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
