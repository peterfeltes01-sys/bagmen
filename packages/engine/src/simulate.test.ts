import { describe, it, expect } from 'vitest'
import { simulateThrow } from './simulate.js'
import { createRng } from './rng.js'
import { BOARD, PHYSICS_DEFAULTS } from './config.js'
import type { BoardState, ThrowInput, PhysicsConfig } from './types.js'

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

  // ── 6. Tunneling: bag landing directly on a lying bag triggers collision ─────

  it('bag landing on a lying bag: collision fires, thrown bag does not pass through', () => {
    // Place a blocker directly where the thrown bag will land.
    // With skill=1.0/focus=1.0 many throws land within bagDiameter of BLOCKER_Y.
    const BLOCKER_Y = 50
    const board: BoardState = {
      bags: [{ id: 'blocker', teamId: 1, x: 0, y: BLOCKER_Y, side: 'fast' }],
    }
    const directShot = goodShot({
      targetX: 0,
      targetY: BLOCKER_Y,
      power: 0.8,
      spin: 0,
      flightType: 'flat',
      skillLevel: 1.0,
      focus: 1.0,
    })

    let collisionCount = 0
    let tunnelCount    = 0   // thrown bag final Y > blocker final Y (pass-through)

    for (let seed = 0; seed < 50; seed++) {
      const { result } = simulateThrow(board, directShot, createRng(seed))
      const pushed = result.pushedBags.find(b => b.id === 'blocker')
      if (pushed) {
        collisionCount++
        // The blocker must have moved forward; the thrown bag must not have overshot it.
        if (result.thrownBag.finalY > pushed.finalY + 0.1) tunnelCount++
      }
    }

    // With σ=6 cm many throws land near BLOCKER_Y — we expect ≥20 collisions.
    expect(collisionCount).toBeGreaterThanOrEqual(20)
    // Thrown bag must never end up ahead of the blocker it hit.
    expect(tunnelCount).toBe(0)
  })

  // ── 7. Side field: fast-side bag slides further than slow-side bag ─────────

  it('fast-side bag slides further than slow-side bag on average', () => {
    // Use spin=+0.001 (fast side) vs spin=−0.001 (slow side): nearly identical
    // lateral components so the only meaningful difference is friction multiplier.
    // Same seed → same Gaussian offset → same landing point → only friction differs.
    const base = goodShot({
      targetX: 0,
      targetY: 50,
      power: 0.8,
      flightType: 'flat',
      skillLevel: 1.0,
      focus: 1.0,
    })

    let fastFurtherCount = 0
    const N = 50
    for (let seed = 0; seed < N; seed++) {
      const fast = simulateThrow(emptyBoard, { ...base, spin:  0.001 }, createRng(seed))
      const slow = simulateThrow(emptyBoard, { ...base, spin: -0.001 }, createRng(seed))
      if (fast.result.thrownBag.finalY > slow.result.thrownBag.finalY) fastFurtherCount++
    }

    // Fast-side friction < slow-side friction → should slide further in ≥70 % of seeds.
    expect(fastFurtherCount).toBeGreaterThanOrEqual(35)
  })

  // ── 8. High-speed bag: swept CCD detects pass-through, kein Durchtunneln ────

  it('high-speed bag: swept CCD detects pass-through, kein Durchtunneln', () => {
    // u1 = 1.0 in Box-Muller → r = sqrt(-2*ln(1)) = 0 → gx = gy = 0.
    // The bag lands exactly at targetX/targetY: fully deterministic, zero scatter.
    // Call order inside simulateThrow: [bagId, u1, u2] — only 3 rng draws needed.
    function zeroScatterRng() {
      const vals = [0.5, 1.0, 0.5]   // u1 = 1.0 is the key value
      let i = 0
      return () => (i < vals.length ? vals[i++] : 0)
    }

    // slideVFlat = 2500 cm/s → step distance ≈ 40 cm (> bagDiameter 15 cm).
    // Bag starts at y = 60 (outside circle [65, 95]), endpoint at y = 100 (outside
    // on the far side): a pure endpoint check would miss this collision entirely.
    const fastPhysics: PhysicsConfig = {
      ...PHYSICS_DEFAULTS,
      slideVFlat: 2500,
      pushFriction: 0,
    }
    const BLOCKER_Y = 80
    const board: BoardState = {
      bags: [{ id: 'blocker', teamId: 1, x: 0, y: BLOCKER_Y, side: 'fast' }],
    }

    // Case A — head-on: bag at (0, 60), blocker at (0, 80)
    {
      const { result } = simulateThrow(
        board,
        goodShot({ targetX: 0, targetY: 60, power: 1.0, spin: 0, flightType: 'flat', skillLevel: 1.0, focus: 1.0 }),
        zeroScatterRng(),
        fastPhysics,
      )
      const pushed = result.pushedBags.find(b => b.id === 'blocker')
      expect(pushed).toBeDefined()                                          // collision detected
      expect(result.thrownBag.finalY).toBeLessThanOrEqual(pushed!.finalY) // kein Durchtunneln
    }

    // Case B — 5 cm lateral offset: bag at (5, 60), blocker at (0, 80)
    {
      const { result } = simulateThrow(
        board,
        goodShot({ targetX: 5, targetY: 60, power: 1.0, spin: 0, flightType: 'flat', skillLevel: 1.0, focus: 1.0 }),
        zeroScatterRng(),
        fastPhysics,
      )
      const pushed = result.pushedBags.find(b => b.id === 'blocker')
      expect(pushed).toBeDefined()
      expect(result.thrownBag.finalY).toBeLessThanOrEqual(pushed!.finalY)
    }
  })

  // ── 9. No bag outside plausible bounds ────────────────────────────────────

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
