import { BOARD, SCATTER, SLIDE, PHYSICS_DEFAULTS } from './config.js'
import type {
  BoardState, ThrowInput, ThrowResult,
  BagResult, BagOnBoard, BagSide, SackOutcome,
  Point, Rng, PhysicsConfig, FlightType,
} from './types.js'

// Box-Muller: two independent N(0,1) samples from two U(0,1) draws
function boxMuller(rng: Rng): [number, number] {
  const u1 = Math.max(rng(), 1e-10)
  const u2 = rng()
  const r = Math.sqrt(-2 * Math.log(u1))
  const theta = 2 * Math.PI * u2
  return [r * Math.cos(theta), r * Math.sin(theta)]
}

function throwSigma(skillLevel: number, focus: number): number {
  return SCATTER.min + SCATTER.spread * (1 - skillLevel) * (1 - focus * 0.5)
}

function inHole(x: number, y: number): boolean {
  const dx = x - BOARD.holeX
  const dy = y - BOARD.holeY
  return dx * dx + dy * dy < BOARD.holeRadius * BOARD.holeRadius
}

function onBoard(x: number, y: number): boolean {
  return (
    x >= -BOARD.halfWidth && x <= BOARD.halfWidth &&
    y >= 0 && y <= BOARD.length
  )
}

function resolveOutcome(x: number, y: number): SackOutcome {
  if (inHole(x, y)) return 'in'
  if (onBoard(x, y)) return 'on'
  return 'off'
}

// Fraction of a bag's area that overlaps with the hole (two circles of equal radius r).
function holeOverlapFraction(bx: number, by: number): number {
  const dx = bx - BOARD.holeX
  const dy = by - BOARD.holeY
  const d  = Math.sqrt(dx * dx + dy * dy)
  const r  = BOARD.holeRadius
  if (d >= 2 * r) return 0
  if (d < 0.001)  return 1
  // Lens area for two equal circles: 2r²·arccos(d/2r) − (d/2)·√(4r²−d²)
  const lensArea = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d)
  return lensArea / (Math.PI * r * r)
}

interface Mover { id: string; x: number; y: number; vx: number; vy: number; friction: number }

function runSlide(
  thrown: Mover,
  lyingBags: readonly BagOnBoard[],
  pushedFriction: number,
  collisionTransfer: number,
): Map<string, { x: number; y: number }> {
  const movers: Mover[] = [{ ...thrown }]
  const statics = new Map(lyingBags.map(b => [b.id, { x: b.x, y: b.y }]))
  const bagD2 = BOARD.bagDiameter * BOARD.bagDiameter

  for (let step = 0; step < SLIDE.maxSteps; step++) {
    // 1. Advance every mover one dt
    for (const m of movers) {
      const spd = Math.sqrt(m.vx * m.vx + m.vy * m.vy)
      if (spd < 0.01) continue
      const newSpd = Math.max(0, spd - m.friction * SLIDE.dt)
      const scale = newSpd / spd
      m.vx *= scale
      m.vy *= scale
      m.x += m.vx * SLIDE.dt
      m.y += m.vy * SLIDE.dt
    }

    // 2. Detect collisions: mover → static bag
    const spawned: Mover[] = []
    for (const m of movers) {
      const spd = Math.sqrt(m.vx * m.vx + m.vy * m.vy)
      if (spd < 0.01) continue
      for (const [sid, sp] of statics) {
        const dx = sp.x - m.x
        const dy = sp.y - m.y
        if (dx * dx + dy * dy >= bagD2) continue
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < 0.001) continue
        const nx = dx / d
        const ny = dy / d
        const dot = m.vx * nx + m.vy * ny
        if (dot <= 0) {
          // Overshoot: thrown bag landed past the static bag and is moving away.
          // Only apply when mover has genuinely overshot in the throw direction.
          if (m.y > sp.y && m.vy > 0) {
            const dotR = -dot  // magnitude of the "wrong-way" velocity component
            spawned.push({
              id: sid, x: sp.x, y: sp.y,
              vx: -dotR * nx * collisionTransfer,
              vy: -dotR * ny * collisionTransfer,
              friction: pushedFriction,
            })
            m.vx += dotR * nx
            m.vy += dotR * ny
            statics.delete(sid)
            break
          }
          continue  // genuinely moving apart — no collision
        }
        spawned.push({
          id: sid, x: sp.x, y: sp.y,
          vx: dot * nx * collisionTransfer,
          vy: dot * ny * collisionTransfer,
          friction: pushedFriction,
        })
        m.vx -= dot * nx
        m.vy -= dot * ny
        statics.delete(sid)
        break  // one collision per mover per step
      }
    }
    movers.push(...spawned)

    // 3. Early exit when nothing is moving
    if (movers.every(m => Math.sqrt(m.vx * m.vx + m.vy * m.vy) < 0.01)) break
  }

  return new Map(movers.map(m => [m.id, { x: m.x, y: m.y }]))
}

function buildTrajectory(
  landX: number,
  landY: number,
  flightType: FlightType,
  physics: PhysicsConfig,
  spin: number,
): Point[] {
  const apex = { flat: physics.apexFlat, airmail: physics.apexAirmail, roll: physics.apexRoll }[flightType]
  const T    = { flat: 1.2,             airmail: 1.6,                  roll: 0.9            }[flightType]
  const pts: Point[] = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    // Lateral bow: parabolic arc toward spin side, peaks at mid-flight, resolves at landing
    pts.push({
      x: landX * t + spin * physics.spinCurvature * 4 * t * (1 - t),
      y: BOARD.throwLineY + (landY - BOARD.throwLineY) * t,
      z: (1 - t) * BOARD.releaseZ + apex * 4 * t * (1 - t),
      t: t * T,
    })
  }
  return pts
}

export function simulateThrow(
  state: BoardState,
  throwInput: ThrowInput,
  rng: Rng,
  physics: PhysicsConfig = PHYSICS_DEFAULTS,
): { state: BoardState; trajectory: Point[]; result: ThrowResult } {
  const { teamId, targetX, targetY, power, spin, flightType, skillLevel, focus } = throwInput

  // Deterministic bag ID from rng
  const bagId = `bag-${((rng() * 0xffffffff) >>> 0).toString(16)}`

  // Sample landing point: Gaussian around target
  const s  = throwSigma(skillLevel, focus)
  const sx = s * (flightType === 'airmail' ? 0.7 : 1.0)
  const sy = s * (flightType === 'roll' ? 0.8 : flightType === 'airmail' ? 0.7 : 1.0)
  const [gx, gy] = boxMuller(rng)
  const landX = targetX + gx * sx
  const landY = targetY + gy * sy

  const trajectory = buildTrajectory(landX, landY, flightType, physics, spin)

  // Bags landing directly in the hole need no further simulation
  if (inHole(landX, landY)) {
    return {
      state,
      trajectory,
      result: {
        thrownBag: { id: bagId, outcome: 'in', finalX: landX, finalY: landY },
        pushedBags: [],
      },
    }
  }

  // Complete miss (off board before sliding)
  if (!onBoard(landX, landY)) {
    return {
      state,
      trajectory,
      result: {
        thrownBag: { id: bagId, outcome: 'off', finalX: landX, finalY: landY },
        pushedBags: [],
      },
    }
  }

  // --- Slide phase ---
  const side: BagSide = spin >= 0 ? 'fast' : 'slow'
  const baseV = { flat: physics.slideVFlat, roll: physics.slideVRoll, airmail: physics.slideVAirmail }[flightType]
  const v0    = power * baseV

  const thrown: Mover = {
    id: bagId,
    x: landX,
    y: landY,
    vx: spin * v0 * 0.3,
    vy: v0,
    friction: physics.pushFriction,
  }

  const finalPos = runSlide(thrown, state.bags, physics.pushedFriction, physics.collisionTransfer)

  // Hole-rim drag-in: a lying bag that starts partially over the hole may fall in when hit
  for (const b of state.bags) {
    const pos = finalPos.get(b.id)
    if (!pos) continue                   // not hit this throw
    if (inHole(pos.x, pos.y)) continue  // already slid in naturally
    const overlap = holeOverlapFraction(b.x, b.y)
    if (overlap > 0 && rng() < overlap) {
      pos.x = BOARD.holeX
      pos.y = BOARD.holeY
    }
  }

  // Build updated board state
  const thrownFinal = finalPos.get(bagId)!
  const thrownBag: BagResult = {
    id: bagId,
    outcome: resolveOutcome(thrownFinal.x, thrownFinal.y),
    finalX: thrownFinal.x,
    finalY: thrownFinal.y,
  }

  const pushedBags: BagResult[] = []
  const nextBags: BagOnBoard[] = []

  for (const existing of state.bags) {
    const moved = finalPos.get(existing.id)
    if (moved) {
      const outcome = resolveOutcome(moved.x, moved.y)
      pushedBags.push({ id: existing.id, outcome, finalX: moved.x, finalY: moved.y })
      if (outcome === 'on') nextBags.push({ ...existing, x: moved.x, y: moved.y })
      // 'in' or 'off' → removed from board
    } else {
      nextBags.push(existing)
    }
  }

  if (thrownBag.outcome === 'on') {
    nextBags.push({ id: bagId, teamId, x: thrownFinal.x, y: thrownFinal.y, side })
  }

  return {
    state: { bags: nextBags },
    trajectory,
    result: { thrownBag, pushedBags },
  }
}
