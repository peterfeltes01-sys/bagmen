import { describe, it, expect } from 'vitest'
import { simulateThrow } from './simulate.js'
import { createRng } from './rng.js'
import { BOARD } from './config.js'
import type { BoardState, ThrowInput } from './types.js'

const emptyBoard: BoardState = { bags: [] }

function goodShot(overrides: Partial<ThrowInput> = {}): ThrowInput {
  return {
    teamId: 0,
    targetX: BOARD.holeX,
    targetY: BOARD.holeY,
    power: 0.6,
    spin: 0.0,
    flightType: 'flat',
    skillLevel: 0.9,
    focus: 0.8,
    ...overrides,
  }
}

// ── 1. Determinism ────────────────────────────────────────────────────────────

describe('simulateThrow', () => {
  it('same seed produces byte-identical results', () => {
    const input = goodShot()
    const r1 = simulateThrow(emptyBoard, input, createRng(42))
    const r2 = simulateThrow(emptyBoard, input, createRng(42))

    expect(r1.result.thrownBag).toEqual(r2.result.thrownBag)
    expect(r1.trajectory).toEqual(r2.trajectory)
    expect(r1.state).toEqual(r2.state)
  })

  it('different seeds can produce different landing points', () => {
    const input = goodShot()
    const a = simulateThrow(emptyBoard, input, createRng(1))
    const b = simulateThrow(emptyBoard, input, createRng(999))
    // At least one coordinate should differ (virtually guaranteed)
    const same =
      a.result.thrownBag.finalX === b.result.thrownBag.finalX &&
      a.result.thrownBag.finalY === b.result.thrownBag.finalY
    expect(same).toBe(false)
  })

  // ── 2. In-rate for a good player ──────────────────────────────────────────

  it('good player aiming at hole: in-rate 30–50 % over 1000 throws', () => {
    // Use spin=0 and very small power so slide barely moves the bag,
    // keeping the test purely about scatter accuracy.
    const input = goodShot({ spin: 0, power: 0.1 })
    let inCount = 0
    for (let seed = 0; seed < 1000; seed++) {
      const { result } = simulateThrow(emptyBoard, input, createRng(seed))
      if (result.thrownBag.outcome === 'in') inCount++
    }
    const rate = inCount / 1000
    expect(rate).toBeGreaterThanOrEqual(0.30)
    expect(rate).toBeLessThanOrEqual(0.50)
  })

  // ── 3. Roll-shot pushes a blocker bag ─────────────────────────────────────

  it('roll shot on a blocker moves it measurably forward', () => {
    const BLOCKER_Y = 78
    const board: BoardState = {
      bags: [{ id: 'blocker', teamId: 1, x: 0, y: BLOCKER_Y, side: 'slow' }],
    }
    // Aim 15 cm in front of the blocker; the roll bag slides into it.
    const rollShot = goodShot({
      targetX: 0,
      targetY: BLOCKER_Y - 15,
      power: 0.8,
      spin: 0.5,
      flightType: 'roll',
      skillLevel: 0.95,
      focus: 0.95,
    })

    let pushCount = 0
    for (let seed = 0; seed < 20; seed++) {
      const { result } = simulateThrow(board, rollShot, createRng(seed))
      const pushed = result.pushedBags.find(b => b.id === 'blocker')
      if (pushed && pushed.finalY > BLOCKER_Y + 2) pushCount++
    }
    // With ~97 % per-throw probability, expect well above 10 in 20 trials.
    expect(pushCount).toBeGreaterThanOrEqual(10)
  })

  // ── 4. Push drives a bag 20 cm from the hole ≥15 cm mean ─────────────────

  it('push aimed 15 cm short drives a bag 20 cm from hole ≥15 cm mean distance', () => {
    const TARGET_Y = BOARD.holeY - 20  // 77 cm from front edge
    const board: BoardState = {
      bags: [{ id: 'target', teamId: 0, x: 0, y: TARGET_Y, side: 'fast' }],
    }
    const pushShot = goodShot({
      targetX:    0,
      targetY:    TARGET_Y - 15,
      power:      0.8,
      spin:       0.5,
      flightType: 'roll',
      skillLevel: 0.95,
      focus:      0.95,
    })

    const pushDistances: number[] = []
    for (let seed = 0; seed < 20; seed++) {
      const { result } = simulateThrow(board, pushShot, createRng(seed))
      const pushed = result.pushedBags.find(b => b.id === 'target')
      if (pushed && pushed.finalY > TARGET_Y) {
        pushDistances.push(pushed.finalY - TARGET_Y)
      }
    }
    expect(pushDistances.length).toBeGreaterThanOrEqual(10)
    const mean = pushDistances.reduce((s, v) => s + v, 0) / pushDistances.length
    expect(mean).toBeGreaterThanOrEqual(15)
  })

  // ── 5. Rim bag (partly over hole) falls in when hit ───────────────────────

  it('bag starting half over hole falls in majority of times when hit', () => {
    // d = 4 cm from hole centre → overlap ≈ 66 %
    const RIM_Y = BOARD.holeY - 4  // 93 cm
    const board: BoardState = {
      bags: [{ id: 'rim', teamId: 1, x: 0, y: RIM_Y, side: 'fast' }],
    }
    const pushShot = goodShot({
      targetX: 0,
      targetY: RIM_Y - 15,
      power: 0.8,
      spin: 0,
      flightType: 'roll',
      skillLevel: 0.95,
      focus: 0.95,
    })

    let inCount = 0
    for (let seed = 0; seed < 20; seed++) {
      const { result } = simulateThrow(board, pushShot, createRng(seed))
      const pushed = result.pushedBags.find(b => b.id === 'rim')
      if (pushed && pushed.outcome === 'in') inCount++
    }
    // Expected ≈ 13 of 20 (66 % overlap × ~100 % hit-rate); asserting ≥ 10 for robustness.
    expect(inCount).toBeGreaterThanOrEqual(10)
  })

  // ── 6. No bag outside plausible bounds ────────────────────────────────────

  it('no bag lands outside plausible board area (no NaN / no explosion)', () => {
    const MARGIN = 3 * BOARD.length  // generous 3× board length

    for (let seed = 0; seed < 100; seed++) {
      const { result, trajectory } = simulateThrow(emptyBoard, goodShot(), createRng(seed))
      const { finalX, finalY } = result.thrownBag

      expect(Number.isFinite(finalX)).toBe(true)
      expect(Number.isFinite(finalY)).toBe(true)
      expect(Math.abs(finalX)).toBeLessThan(BOARD.halfWidth + MARGIN)
      expect(finalY).toBeGreaterThan(-MARGIN)
      expect(finalY).toBeLessThan(BOARD.length + MARGIN)

      for (const p of trajectory) {
        expect(Number.isFinite(p.x)).toBe(true)
        expect(Number.isFinite(p.y)).toBe(true)
        expect(Number.isFinite(p.z)).toBe(true)
        expect(p.z).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
