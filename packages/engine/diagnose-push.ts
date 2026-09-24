/**
 * Diagnostic: 50 push throws at a bag 20 cm from the hole.
 * Run with:  npx tsx packages/engine/diagnose-push.ts
 *
 * Checks three suspects:
 *  A) computeIdealPower slide estimate vs. actual simulation
 *  B) Collision radius (edge vs. center)
 *  C) Friction stops bag before it reaches the target
 */

import { simulateThrow } from './src/simulate.js'
import { createRng }      from './src/rng.js'
import { BOARD, SLIDE, PHYSICS_DEFAULTS } from './src/config.js'
import type { BoardState, ThrowInput }    from './src/types.js'

// ── Mirror of GameCanvas constants ──────────────────────────────────────────
const MIN_LAND_Y = -40
const MAX_LAND_Y = 170

function computeIdealPower(by: number): number {
  const physics = PHYSICS_DEFAULTS
  const a = physics.slideVRoll * physics.slideVRoll / (2 * physics.pushFriction)
  const r = MAX_LAND_Y - MIN_LAND_Y
  const p = (-r + Math.sqrt(r * r + 4 * a * (-MIN_LAND_Y + by))) / (2 * a)
  return Math.max(0, Math.min(1, p))
}

function formulaSlide(power: number): number {
  const v0 = power * PHYSICS_DEFAULTS.slideVRoll
  return v0 * v0 / (2 * PHYSICS_DEFAULTS.pushFriction)
}

// ── Discrete slide simulation (mirror of runSlide, single bag, no statics) ──
function simulateSlide(v0: number, spin: number): number {
  const vx0 = spin * v0 * 0.3
  const vy0 = v0
  let vx = vx0, vy = vy0, y = 0
  for (let s = 0; s < SLIDE.maxSteps; s++) {
    const spd = Math.sqrt(vx * vx + vy * vy)
    if (spd < 0.01) break
    const newSpd = Math.max(0, spd - PHYSICS_DEFAULTS.pushFriction * SLIDE.dt)
    const scale = newSpd / spd
    vx *= scale; vy *= scale
    y += vy * SLIDE.dt
  }
  return y
}

// ── Setup ────────────────────────────────────────────────────────────────────
const TARGET_Y = BOARD.holeY - 20  // 77 cm  (20 cm vor dem Loch)

const board: BoardState = {
  bags: [{ id: 'target', teamId: 0, x: 0, y: TARGET_Y, side: 'fast' }],
}

const idealP      = computeIdealPower(TARGET_Y)
const predictedLandY = MIN_LAND_Y + idealP * (MAX_LAND_Y - MIN_LAND_Y)
const predictedSlide = formulaSlide(idealP)
const actualSlide0   = simulateSlide(idealP * PHYSICS_DEFAULTS.slideVRoll, 0)   // spin=0
const actualSlide05  = simulateSlide(idealP * PHYSICS_DEFAULTS.slideVRoll, 0.5) // spin=0.5

console.log('\n══ A) Slide estimate vs. simulation (spin=0) ═════════════════════════')
console.log(`  Target bag Y:          ${TARGET_Y} cm`)
console.log(`  Ideal power:           ${idealP.toFixed(4)}`)
console.log(`  Predicted landing Y:   ${predictedLandY.toFixed(2)} cm`)
console.log(`  Predicted slide (formula):   ${predictedSlide.toFixed(2)} cm  →  final ${(predictedLandY + predictedSlide).toFixed(2)} cm`)
console.log(`  Actual slide (sim, spin=0):  ${actualSlide0.toFixed(2)} cm  →  final ${(predictedLandY + actualSlide0).toFixed(2)} cm`)
console.log(`  Actual slide (sim, spin=0.5):${actualSlide05.toFixed(2)} cm  →  final ${(predictedLandY + actualSlide05).toFixed(2)} cm`)
console.log(`  Δ (formula - sim, spin=0):   ${(predictedSlide - actualSlide0).toFixed(3)} cm`)

// ── 50-throw batch ────────────────────────────────────────────────────────────
console.log('\n══ C) 50 push throws — skill=0.72, focus=0.85, spin=0.5 ══════════════')

const input: ThrowInput = {
  teamId:     0,
  targetX:    0,
  targetY:    predictedLandY,   // exact predicted landing point (= idealP used)
  power:      idealP,
  spin:       0.5,
  flightType: 'roll',
  skillLevel: 0.72,
  focus:      0.85,
}

type Row = {
  seed: number
  landY: number        // actual landing Y (after scatter)
  distAtLand: number   // center-to-center distance at start of slide
  collisionY: number   // Y of thrown bag when collision fired (NaN if no hit)
  vAtCollision: number // speed at collision (0 if no hit)
  pushed: boolean
  pushedFinalY: number
  thrownFinalY: number
}

const rows: Row[] = []

for (let seed = 0; seed < 50; seed++) {
  const { result, trajectory } = simulateThrow(board, input, createRng(seed))
  const landPt  = trajectory[trajectory.length - 1]
  const landY   = landPt.y
  const dist    = Math.abs(landY - TARGET_Y)
  const pushed  = result.pushedBags.length > 0
  const pushFin = pushed ? result.pushedBags[0].finalY : NaN

  // Reconstruct at what Y collision fired and with what velocity
  // by replaying the slide manually
  let collY = NaN, vColl = 0
  if (pushed) {
    const v0  = input.power * PHYSICS_DEFAULTS.slideVRoll
    const vx0 = input.spin * v0 * 0.3
    const vy0 = v0
    let vx = vx0, vy = vy0, cx = landPt.x, cy = landY
    const bagD2 = BOARD.bagDiameter * BOARD.bagDiameter
    for (let s = 0; s < SLIDE.maxSteps; s++) {
      const spd = Math.sqrt(vx * vx + vy * vy)
      if (spd < 0.01) break
      const newSpd = Math.max(0, spd - PHYSICS_DEFAULTS.pushFriction * SLIDE.dt)
      const scale = newSpd / spd
      vx *= scale; vy *= scale
      cx += vx * SLIDE.dt; cy += vy * SLIDE.dt
      const dx = 0 - cx, dy = TARGET_Y - cy
      if (dx * dx + dy * dy < bagD2) { collY = cy; vColl = Math.sqrt(vx*vx + vy*vy); break }
    }
  }

  rows.push({
    seed,
    landY:          landY,
    distAtLand:     dist,
    collisionY:     collY,
    vAtCollision:   vColl,
    pushed,
    pushedFinalY:   pushFin,
    thrownFinalY:   result.thrownBag.finalY,
  })
}

const hits        = rows.filter(r => r.pushed)
const misses      = rows.filter(r => !r.pushed)
const landMean    = rows.reduce((s, r) => s + r.landY, 0) / rows.length
const landDev     = Math.sqrt(rows.reduce((s, r) => s + (r.landY - landMean) ** 2, 0) / rows.length)
const landDevExpected = predictedLandY - (predictedLandY - TARGET_Y + BOARD.bagDiameter) // furthest Y that still hits
const pushMean    = hits.length ? hits.reduce((s, r) => s + (r.pushedFinalY - TARGET_Y), 0) / hits.length : NaN
const vMean       = hits.length ? hits.reduce((s, r) => s + r.vAtCollision, 0) / hits.length : NaN

console.log(`  Predicted landing Y:   ${predictedLandY.toFixed(2)} cm`)
console.log(`  Actual land Y mean:    ${landMean.toFixed(2)} cm  (σ = ${landDev.toFixed(2)} cm)`)
console.log(`  Δ mean (predicted - actual): ${(predictedLandY - landMean).toFixed(2)} cm`)
console.log('')
console.log(`  Hit rate:   ${hits.length}/50  (${(hits.length * 2).toFixed(0)} %)`)
console.log(`  Miss rate:  ${misses.length}/50`)
if (hits.length > 0) {
  console.log(`  Mean push distance:    ${pushMean.toFixed(1)} cm`)
  console.log(`  Mean speed at collision: ${vMean.toFixed(1)} cm/s`)
}

console.log('\n══ B) Collision threshold check ══════════════════════════════════════')
console.log(`  BOARD.bagDiameter:     ${BOARD.bagDiameter} cm  (radius ${BOARD.bagDiameter/2} cm)`)
console.log(`  Collision fires when   center-to-center < ${BOARD.bagDiameter} cm`)
console.log(`  Two 7.5 cm-radius bags touch at center dist = ${BOARD.bagDiameter} cm  → OK`)

const closeMisses = misses.filter(r => r.thrownFinalY >= TARGET_Y - BOARD.bagDiameter)
console.log(`  Misses where thrown bag ended within ${BOARD.bagDiameter} cm of target (centre): ${closeMisses.length}`)
closeMisses.forEach(r =>
  console.log(`    seed ${r.seed}: landY=${r.landY.toFixed(1)}, thrownFinal=${r.thrownFinalY.toFixed(1)}, dist=${(TARGET_Y - r.thrownFinalY).toFixed(1)} cm`)
)

console.log('\n══ Per-throw log (seed | landY | dist@land | hit | collY | vColl | pushΔY | finalY) ═══')
rows.forEach(r => {
  const push = r.pushed ? `HIT  collY=${r.collisionY.toFixed(1)} vColl=${r.vAtCollision.toFixed(0)} pushΔY=+${(r.pushedFinalY - TARGET_Y).toFixed(1)}` : `MISS thrownFinal=${r.thrownFinalY.toFixed(1)}`
  console.log(`  ${String(r.seed).padStart(2)} | landY=${r.landY.toFixed(1).padStart(6)} | distAtLand=${r.distAtLand.toFixed(1).padStart(5)} cm | ${push}`)
})

// ── Extra: what power does the player actually need to reliably push? ────────
console.log('\n══ D) Required power for bag to always reach collision threshold ══════')
// Collision fires when thrown-bag center is within 15 cm of target (y=77).
// At landing, bag at landY must be able to slide to landY + slide ≥ 77 - 15 = 62.
// So: landY + v0²/(2f) ≥ 62 → v0 ≥ sqrt(2f*(62-landY))
// Worst case (full -2σ scatter): landY = predictedLandY - 2*landDev
const worstLandY = predictedLandY - 2 * landDev
const neededV0   = Math.sqrt(Math.max(0, 2 * PHYSICS_DEFAULTS.pushFriction * (TARGET_Y - BOARD.bagDiameter - worstLandY)))
const neededP    = neededV0 / PHYSICS_DEFAULTS.slideVRoll
console.log(`  Worst-case landing (−2σ): ${worstLandY.toFixed(1)} cm`)
console.log(`  Must slide to:            ${(TARGET_Y - BOARD.bagDiameter).toFixed(1)} cm  (edge touch)`)
console.log(`  Required v0 at that landing: ${neededV0.toFixed(1)} cm/s  → power ${neededP.toFixed(3)}`)
console.log(`  Ideal power for TARGET_Y:    ${idealP.toFixed(3)}`)
console.log(`  Gap (idealP - neededP):      ${(idealP - neededP).toFixed(3)}`)
console.log('  → If gap > 0: ideal power is enough for worst-case 2σ miss')
console.log('    If gap < 0: player needs MORE than ideal power to be robust against scatter\n')
