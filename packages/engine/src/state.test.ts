import { describe, it, expect } from 'vitest'
import { createInitialState, applyThrow } from './state.js'
import { ENGINE_HASH } from './config.js'

const params = { speed: 0.6, angle: 0, spin: 0, loft: 0.5 }

describe('createInitialState', () => {
  it('starts at frame 1, team 0, score 0-0', () => {
    const s = createInitialState()
    expect(s.currentFrame).toBe(1)
    expect(s.currentTeam).toBe(0)
    expect(s.totalScore0).toBe(0)
    expect(s.totalScore1).toBe(0)
    expect(s.phase).toBe('playing')
    expect(s.engineHash).toBe(ENGINE_HASH)
  })
})

describe('applyThrow', () => {
  it('does not mutate the original state', () => {
    const state = createInitialState()
    applyThrow(state, params, 1)
    expect(state.throwsThisFrame).toBe(0)
  })

  it('is deterministic: same seed → same result', () => {
    const state = createInitialState()
    const r1 = applyThrow(state, params, 42)
    const r2 = applyThrow(state, params, 42)
    expect(r1.outcome).toBe(r2.outcome)
    expect(r1.landing).toEqual(r2.landing)
    expect(r1.trajectory.length).toBe(r2.trajectory.length)
  })

  it('different seeds produce different landing positions', () => {
    const state = createInitialState()
    const positions = Array.from({ length: 10 }, (_, i) =>
      applyThrow(state, params, i * 7).landing
    )
    const uniqueX = new Set(positions.map(p => p.x.toFixed(4)))
    expect(uniqueX.size).toBeGreaterThan(1)
  })

  it('advances throwsThisFrame by 1 each call', () => {
    let state = createInitialState()
    for (let i = 0; i < 4; i++) {
      const r = applyThrow(state, params, i)
      expect(r.state.throwsThisFrame).toBe(i + 1)
      state = r.state
    }
  })

  it('switches to team 1 after 4 throws', () => {
    let state = createInitialState()
    for (let i = 0; i < 4; i++) {
      state = applyThrow(state, params, i).state
    }
    expect(state.currentTeam).toBe(1)
  })

  it('advances to frame 2 after 8 throws', () => {
    let state = createInitialState()
    for (let i = 0; i < 8; i++) {
      state = applyThrow(state, params, i).state
    }
    expect(state.currentFrame).toBe(2)
    expect(state.throwsThisFrame).toBe(0)
    expect(state.currentTeam).toBe(0)
  })

  it('returns miss when phase is finished', () => {
    const state = { ...createInitialState(), phase: 'finished' as const }
    const r = applyThrow(state, params, 1)
    expect(r.outcome).toBe('miss')
    expect(r.trajectory).toHaveLength(0)
  })
})
