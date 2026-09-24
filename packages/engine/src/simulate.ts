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
  const lensArea = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d)
  return lensArea / (Math.PI * r * r)
}

// Smallest t in [0,1] at which the segment P0→P1 first enters a circle of radius R around Q.
// Returns 0 immediately when P0 is already inside the circle.
// Returns null when the segment never enters the circle within this step.
function sweptContactT(
  p0x: number, p0y: number,
  p1x: number, p1y: number,
  qx:  number, qy:  number,
  R:   number,
): number | null {
  const d0sq = (p0x - qx) ** 2 + (p0y - qy) ** 2
  if (d0sq < R * R) return 0    // already inside: contact at t=0

  const dx = p1x - p0x
  const dy = p1y - p0y
  const fx = p0x - qx
  const fy = p0y - qy

  const a = dx * dx + dy * dy
  if (a < 1e-12) return null    // mover is stationary

  const b    = 2 * (fx * dx + fy * dy)
  const c    = fx * fx + fy * fy - R * R
  const disc = b * b - 4 * a * c
  if (disc < 0) return null     // path doesn't reach circle

  const sq = Math.sqrt(disc)
  const t1 = (-b - sq) / (2 * a)
  const t2 = (-b + sq) / (2 * a)

  if (t1 >= 0 && t1 <= 1) return t1
  if (t2 >= 0 && t2 <= 1) return t2
  return null
}

interface Mover { id: string; x: number; y: number; vx: number; vy: number; friction: number }

function runSlide(
  thrown:    Mover,
  lyingBags: readonly BagOnBoard[],
  physics:   PhysicsConfig,
): Map<string, { x: number; y: number }> {
  const { pushedFriction, collisionTransfer, sideFrictionFast, sideFrictionSlow } = physics
  const movers: Mover[] = [{ ...thrown }]
  // Store full BagOnBoard so side-dependent friction can be computed on impact.
  const statics = new Map<string, BagOnBoard>(lyingBags.map(b => [b.id, b]))
  const R = BOARD.bagDiameter

  for (let step = 0; step < SLIDE.maxSteps; step++) {
    const spawned: Mover[] = []

    for (const m of movers) {
      const spd = Math.sqrt(m.vx * m.vx + m.vy * m.vy)
      if (spd < 0.01) continue

      // Apply friction and compute candidate new position.
      const newSpd = Math.max(0, spd - m.friction * SLIDE.dt)
      const scale  = newSpd / spd
      const vxPost = m.vx * scale
      const vyPost = m.vy * scale
      const nx_    = m.x + vxPost * SLIDE.dt
      const ny_    = m.y + vyPost * SLIDE.dt

      // Find the earliest swept contact with any static bag this step.
      let earliest: { t: number; sid: string; bag: BagOnBoard } | null = null
      for (const [sid, bag] of statics) {
        const t = sweptContactT(m.x, m.y, nx_, ny_, bag.x, bag.y, R)
        if (t !== null && (earliest === null || t < earliest.t)) {
          earliest = { t, sid, bag }
        }
      }

      if (earliest === null) {
        // No contact this step.
        m.x = nx_; m.y = ny_; m.vx = vxPost; m.vy = vyPost
        continue
      }

      const { t, sid, bag } = earliest

      // Contact position along the step.
      let cx = m.x + vxPost * SLIDE.dt * t
      let cy = m.y + vyPost * SLIDE.dt * t

      // When the mover already overlaps the static (t=0), back it up to the
      // approach-side contact surface so the collision fires head-on.
      if (t === 0) {
        const spd2 = Math.sqrt(vxPost * vxPost + vyPost * vyPost)
        if (spd2 > 0.001) {
          cx = bag.x - (vxPost / spd2) * R
          cy = bag.y - (vyPost / spd2) * R
        }
      }

      // Normal vector from contact point toward the static bag's centre.
      const ex = bag.x - cx
      const ey = bag.y - cy
      const ed = Math.sqrt(ex * ex + ey * ey)

      let nx: number, ny: number
      if (ed < 0.001) {
        // Centers coincide — use anti-velocity as separating normal.
        const spd3 = Math.sqrt(vxPost * vxPost + vyPost * vyPost)
        if (spd3 < 0.001) {
          // Mover is also stationary: nothing to resolve, advance normally.
          m.x = nx_; m.y = ny_; m.vx = vxPost; m.vy = vyPost
          continue
        }
        nx = vxPost / spd3
        ny = vyPost / spd3
      } else {
        nx = ex / ed
        ny = ey / ed
      }
      const dot = vxPost * nx + vyPost * ny

      const sf = bag.side === 'fast' ? sideFrictionFast : sideFrictionSlow
      const pf = pushedFriction * sf

      if (dot > 0) {
        // Normal approach: mover is moving toward the static.
        spawned.push({
          id: sid, x: bag.x, y: bag.y,
          vx: dot * nx * collisionTransfer,
          vy: dot * ny * collisionTransfer,
          friction: pf,
        })
        m.x = cx; m.y = cy
        m.vx = vxPost - dot * nx
        m.vy = vyPost - dot * ny
        statics.delete(sid)
      } else if (cy > bag.y && vyPost > 0) {
        // Overshoot: mover landed past the static and is moving away in throw direction.
        const dotR = -dot
        spawned.push({
          id: sid, x: bag.x, y: bag.y,
          vx: -dotR * nx * collisionTransfer,
          vy: -dotR * ny * collisionTransfer,
          friction: pf,
        })
        m.x = cx; m.y = cy
        m.vx = vxPost + dotR * nx
        m.vy = vyPost + dotR * ny
        statics.delete(sid)
      } else {
        // Moving apart or tangential pass — no impulse, advance normally.
        // Static is kept so subsequent steps can re-check.
        m.x = nx_; m.y = ny_; m.vx = vxPost; m.vy = vyPost
      }
    }

    movers.push(...spawned)

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

  const bagId = `bag-${((rng() * 0xffffffff) >>> 0).toString(16)}`

  const s  = throwSigma(skillLevel, focus)
  const sx = s * (flightType === 'airmail' ? 0.7 : 1.0)
  const sy = s * (flightType === 'roll' ? 0.8 : flightType === 'airmail' ? 0.7 : 1.0)
  const [gx, gy] = boxMuller(rng)
  const landX = targetX + gx * sx
  const landY = targetY + gy * sy

  const trajectory = buildTrajectory(landX, landY, flightType, physics, spin)

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

  // Apply side-dependent friction: fast-side slides further, slow-side stops sooner.
  const sideMultiplier = side === 'fast' ? physics.sideFrictionFast : physics.sideFrictionSlow
  const thrown: Mover = {
    id: bagId,
    x: landX,
    y: landY,
    vx: spin * v0 * 0.3,
    vy: v0,
    friction: physics.pushFriction * sideMultiplier,
  }

  const finalPos = runSlide(thrown, state.bags, physics)

  // Hole-rim drag-in: a lying bag that starts partially over the hole may fall in when hit
  for (const b of state.bags) {
    const pos = finalPos.get(b.id)
    if (!pos) continue
    if (inHole(pos.x, pos.y)) continue
    const overlap = holeOverlapFraction(b.x, b.y)
    if (overlap > 0 && rng() < overlap) {
      pos.x = BOARD.holeX
      pos.y = BOARD.holeY
    }
  }

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
